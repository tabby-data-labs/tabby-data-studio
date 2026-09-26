# Tabby — Architecture

Back to [`PLAN.md`](../PLAN.md).

---

## 1. Process model

| Process      | Runtime                  | Responsibilities                                                                                                                                      | Must never                                                       |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **main**     | Electron 44 / Node 24.21 | All `pg` access, connection lifecycle, cursors, result registry, schema introspection, settings + secrets, export-to-disk, IPC routing and validation | Touch the DOM; block the event loop with a long synchronous task |
| **preload**  | Sandboxed                | Expose one frozen, typed `window.tabby` surface via `contextBridge`                                                                                   | Expose `ipcRenderer`, `require`, or any Node global              |
| **renderer** | Chromium 152, Vue 3.5    | All UI, the canvas grid, schema tree, query console, tabs                                                                                             | Import Node built-ins; construct SQL; hold a plaintext password  |

With `sandbox: true`, the preload can only `require` a small polyfilled subset (`electron` renderer APIs, `events`, `timers`, `url`). Everything else — validation, crypto, SQL — lives in **main**. That constraint is a feature; do not relax it.

---

## 2. Folder layout

```
tabby/
├─ package.json                  # no "type": "module"
├─ electron.vite.config.ts
├─ tsconfig.json                 # solution refs
├─ tsconfig.node.json            # main + preload
├─ tsconfig.web.json             # renderer
├─ docker-compose.yml            # postgres:17 for integration tests
├─ src/
│  ├─ main/
│  │  ├─ index.ts                # app lifecycle, window creation
│  │  ├─ window/                 # create/restore, state persistence
│  │  ├─ security/               # CSP, navigation + new-window guards
│  │  ├─ ipc/
│  │  │  ├─ router.ts            # channel → handler dispatch
│  │  │  └─ validate.ts          # hand-written boundary validators
│  │  ├─ db/
│  │  │  ├─ connection-manager.ts
│  │  │  ├─ driver-pg.ts         # the ONLY file importing 'pg'
│  │  │  ├─ query-executor.ts
│  │  │  ├─ cursor-store.ts      # DECLARE/FETCH/MOVE, TTL, LRU
│  │  │  ├─ introspect.ts        # pg_catalog queries
│  │  │  ├─ identifier.ts        # quoteIdent / validation
│  │  │  └─ codec.ts             # row → columnar transfer format
│  │  ├─ store/                  # settings JSON + safeStorage
│  │  └─ export/                 # streamed CSV/JSON/SQL writers
│  ├─ preload/
│  │  └─ index.ts
│  ├─ renderer/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ app/                  # shell, routing, layout
│  │     ├─ components/           # SchemaTree, QueryConsole, ResultTabs…
│  │     ├─ grid/                 # ◄── see GRID-SPEC.md; imports nothing above
│  │     ├─ sql/                  # lexer, splitter, highlighter
│  │     ├─ stores/               # pinia
│  │     └─ styles/
│  └─ shared/                     # imported by ALL THREE processes
│     ├─ ipc-contract.ts          # channel names + request/response types
│     ├─ domain.ts                # ConnectionConfig, TableMeta, ColumnMeta…
│     └─ errors.ts                # tagged error union
└─ tests/
   ├─ unit/
   ├─ integration/                # requires a live Postgres
   └─ fixtures/
```

### Boundary rules (enforced by ESLint `no-restricted-imports`)

1. `src/shared/**` may not import from `main`, `preload`, `renderer`, `vue`, `pinia`, or any Node built-in.
2. `src/renderer/src/grid/**` may not import from `app/`, `components/`, `stores/`, or `shared/ipc-contract`. It knows only its own `DataSource` interface. This is what makes the grid independently testable and reusable.
3. `pg` is imported in exactly **one** file: `src/main/db/driver-pg.ts`. Everything else goes through the `Driver` interface, so the v2 "second engine" work is a new file, not a refactor.

---

## 3. IPC contract

Defined once in `src/shared/ipc-contract.ts` and consumed by both sides.

```ts
export const IpcChannel = {
  // connections
  connList: 'conn:list',
  connSave: 'conn:save',
  connDelete: 'conn:delete',
  connTest: 'conn:test',
  connOpen: 'conn:open',
  connClose: 'conn:close',

  // schema
  schemaTree: 'schema:tree',
  schemaTable: 'schema:table', // columns, indexes, constraints, ddl
  schemaRefresh: 'schema:refresh',

  // queries
  queryRun: 'query:run', // → { resultId } immediately
  queryCancel: 'query:cancel',

  // results (windowed — never ship a whole result set)
  resultMeta: 'result:meta', // columns + rowCountEstimate
  resultWindow: 'result:window', // (resultId, startRow, rowCount) → columnar batch
  resultDispose: 'result:dispose',

  // events (main → renderer)
  evQueryProgress: 'event:query-progress',
  evConnectionLost: 'event:connection-lost',
  evResultEvicted: 'event:result-evicted',
} as const;
```

Rules:

- **Requests are validated in main**, always. The renderer is treated as untrusted input — a compromised renderer must not be able to make main interpolate arbitrary SQL.
- Every response is a discriminated union: `{ ok: true, value: T } | { ok: false, error: TabbyError }`. No throwing across the bridge; thrown errors lose their shape.
- Long operations return a **handle immediately** (`queryRun` → `resultId`) and stream progress over `evQueryProgress`. The renderer polls windows on demand.
- Payloads crossing the bridge are size-checked; anything over a few MB must be a file path (export) or a windowed batch.

---

## 4. The `DataSource` boundary

The grid depends on this and nothing else:

```ts
export interface ColumnMeta {
  name: string;
  typeOid: number;
  typeName: string; // 'int8' | 'timestamptz' | 'jsonb' | …
  nullable: boolean;
  widthHint: number; // initial column width
}

export type CellValue =
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: number; raw: string } // raw avoids float display lies for numeric
  | { kind: 'text'; value: string }
  | { kind: 'time'; value: number; tz: string } // epoch ms + original zone
  | { kind: 'binary'; byteLength: number; preview: Uint8Array }
  | { kind: 'json'; preview: string; byteLength: number }
  | { kind: 'error'; message: string }; // parse failure shown inline, not fatal

export type RowBlock = {
  startRow: number;
  rowCount: number;
  columns: CellValue[][]; // column-major: columns[c][r]
};

export interface DataSource {
  readonly columns: readonly ColumnMeta[];
  readonly rowCount: number; // -1 while unknown
  readonly rowCountIsEstimate: boolean;
  getBlock(startRow: number, rowCount: number, signal: AbortSignal): Promise<RowBlock>;
  sort(columnIndex: number, direction: 'asc' | 'desc' | null): Promise<void>;
}
```

Three implementations, all satisfying the same contract:

| Implementation       | Used in               | Notes                                                                                    |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `FakeDataSource`     | Phase 1–2, unit tests | Deterministic 1M×30 synthetic rows. Lets the grid be finished before any DB code exists. |
| `RemoteDataSource`   | Phase 5+              | Wraps IPC; read-ahead prefetch, in-flight dedupe, stale-response abort.                  |
| `InMemoryDataSource` | Small results, tests  | Whole result already local.                                                              |

Phase 5's exit criterion is that the grid's own API and tests do **not** change when `Fake` is swapped for `Remote`. If they do, the boundary was wrong — fix the boundary, not the grid.

---

## 5. Data layer

### 5.1 Connection lifecycle

One `pg.Pool` per saved connection, `max: 2` (one for queries, one reserved for `pg_cancel_backend`). Connect lazily; verify with a cheap `SELECT 1`; tear down on window close and on idle timeout.

On every new connection, immediately:

```sql
SET default_transaction_read_only = on;
SET statement_timeout = '30s';
SET idle_in_transaction_session_timeout = '60s';
SET lock_timeout = '5s';
SET client_encoding = 'UTF8';
SET DateStyle = 'ISO, MDY';
SET timezone = 'UTC';          -- normalise; convert for display in the renderer
```

`default_transaction_read_only` is the **real** v1 safety guarantee: it is enforced by Postgres, so a bug in our SQL construction cannot write. A test asserts that an `INSERT` over a Tabby connection fails with SQLSTATE `25006` (`read_only_sql_transaction`). Recommend users also connect with a read-only role.

### 5.2 Positionable large results

`OFFSET 900000` makes Postgres scan and discard 900k rows — scrolling to the bottom of a big table would take seconds. Use a server-side cursor instead:

```sql
BEGIN;
DECLARE tabby_c_<resultId> NO SCROLL CURSOR FOR <query>;
FETCH 1000 FROM tabby_c_<resultId>;        -- first window
MOVE ABSOLUTE 900000 IN tabby_c_<resultId>; -- arbitrary jump
FETCH 1000 FROM tabby_c_<resultId>;
```

`NO SCROLL` is deliberate — bidirectional cursors force Postgres to materialise the whole result. The grid only ever moves forward plus jumps, which `MOVE ABSOLUTE` covers.

Trade-off to manage: the cursor holds a transaction open, which pins xmin and can cause table bloat on a busy production database. Mitigations: `idle_in_transaction_session_timeout`, aggressive cursor close on tab disposal, TTL + LRU eviction in the registry, and — when a table has a usable PK — prefer **keyset pagination** (`WHERE (a,b) > ($1,$2) ORDER BY a,b LIMIT n`) which needs no open transaction at all. Keyset is the default where a PK exists; cursors are the fallback.

### 5.3 `ResultRegistry`

`resultId` → `{ cursor | keysetState, columns, rowCount, lastAccess, bytesHeld }`.

- Max concurrent results (default 20), TTL (default 10 min idle), total memory cap
- LRU eviction emits `evResultEvicted` so the renderer can show "result expired — re-run query" instead of blank cells
- Disposed on tab close and on connection loss

### 5.4 Columnar transfer codec

Shipping 1M JS row objects across `contextBridge` is slow and memory-hungry. Instead send column-major typed arrays and transfer the underlying buffers:

- `int2/int4/float4/float8` → `Float64Array` + a `nullBitmap: Uint8Array`
- `int8/numeric` → keep as **strings** in a flat `Uint32Array` offset table + one `Uint8Array` UTF-8 blob (avoids `BigInt` and precision loss)
- `text/varchar/json` → same offset-table + blob approach
- `bool` → bit-packed `Uint8Array`
- `timestamptz` → `Float64Array` of epoch ms
- `bytea` → offset table + blob

Decode lazily in the renderer into `CellValue` per _visible_ cell only. Never decode a whole block eagerly.

### 5.5 Cancellation

Capture `pg_backend_pid()` when a query starts, store it against the `resultId`, and issue `SELECT pg_cancel_backend($1)` on the **reserved second connection**. Cancelling on the busy connection is impossible — it is blocked waiting for the server.

### 5.6 Identifier safety

`quoteIdent(s)`: reject anything outside `[A-Za-z0-9_$]` plus a length cap, then double any embedded `"`. All object names arriving from the renderer pass through it. All _values_ go through `pg`'s parameter binding (`$1, $2`), never string interpolation.

---

## 6. Designed-in for v2 editing (interfaces only in v1)

```ts
interface RowIdentityResolver {
  resolve(table: TableMeta): RowKey | null; // PK or best unique index
}
interface ChangeBuffer {
  set(resultId: string, row: RowKey, col: string, next: CellValue): void;
  changesFor(row: RowKey): Change[];
  toSql(): { text: string; values: unknown[] }[]; // built in MAIN, parameterised
}
```

In v1 these exist as types with a no-op implementation so the grid, codec, and IPC contract do not need reshaping later. Editing additionally requires dropping `default_transaction_read_only` per-transaction and an optimistic-concurrency check (`WHERE pk = $1 AND col IS NOT DISTINCT FROM $2`).

---

## 7. Security hardening checklist

### BrowserWindow

```ts
new BrowserWindow({
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true, // required
    nodeIntegration: false, // required
    sandbox: true, // required
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false,
  },
  show: false, // reveal on 'ready-to-show' to avoid white flash
});
```

### Navigation and windows

```ts
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // no in-app popups; https links open in the default browser only
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e) => e.preventDefault());
});
```

Nothing in this app navigates. Deny all of it.

### Content Security Policy

Production:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

No `unsafe-eval` — Vue 3's runtime-only build compiles SFCs ahead of time. Dev needs a looser policy for Vite's HMR websocket and inline styles; keep them as two separate constants so the production policy is never accidentally relaxed. Apply via `session.defaultSession.webRequest.onHeadersReceived`, not only a `<meta>` tag.

### Secrets

Connection passwords go through `safeStorage.encryptString()` — Electron's OS keychain-backed encryption (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Store base64 ciphertext in the settings JSON; decrypt only in main, only at connect time. Never send a password to the renderer, never log one, and redact `password` from any error object before it crosses IPC.

### Supply chain

See [`PLAN.md` §3](../PLAN.md#3-dependency-budget--the-security-contract). One runtime dependency; CI asserts it.

### Query privacy

Query history and saved queries can contain literals, including secrets. Store locally only, never sync, offer clear-history, and exclude them from any future crash report.

---

## 8. Error model

One tagged union in `src/shared/errors.ts`, so the renderer can branch on `code` rather than pattern-matching message strings:

```ts
type TabbyError =
  | { code: 'CONN_REFUSED' | 'AUTH_FAILED' | 'SSL_REQUIRED' | 'DNS_FAILED'; detail: string }
  | { code: 'QUERY_TIMEOUT' | 'QUERY_CANCELLED'; detail: string; sqlState?: string }
  | {
      code: 'SYNTAX_ERROR' | 'RELATION_NOT_FOUND';
      detail: string;
      sqlState: string;
      position?: number;
    }
  | { code: 'RESULT_EVICTED' | 'CURSOR_CLOSED'; resultId: string }
  | { code: 'PERMISSION_DENIED'; detail: string }
  | { code: 'VALIDATION_FAILED'; field: string }
  | { code: 'INTERNAL'; detail: string };
```

Map `pg`'s `error.code` (SQLSTATE) to these in `driver-pg.ts` — the single place that knows `pg` exists. Syntax errors carry `position` so the console can underline the offending token.

---

## 9. Persistence

Everything under `app.getPath('userData')`:

| File                 | Format                          | Contents                                                               |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `settings.json`      | JSON                            | Connections (passwords ciphertext), theme, grid prefs, window geometry |
| `history.jsonl`      | Append-only JSONL, size-rotated | Query history                                                          |
| `saved-queries.json` | JSON                            | Named queries                                                          |

Atomic writes: write `settings.json.tmp` then `rename()`. No SQLite in v1 — it would add a native module and a rebuild step for every Electron upgrade, and nothing in v1 needs it.
