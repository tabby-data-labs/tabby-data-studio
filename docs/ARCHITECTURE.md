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
├─ tsconfig.web.json             # renderer + tests
├─ scripts/
│  ├─ check-deps.mjs             # runtime dependency budget
│  └─ pg-fixtures.sql            # idempotent fixtures for tests/integration
├─ src/
│  ├─ main/
│  │  ├─ index.ts                # app lifecycle, window creation
│  │  ├─ window/                 # create/restore, state persistence
│  │  ├─ security/               # CSP, navigation + new-window guards
│  │  ├─ log.ts                  # every line passes through scrub()
│  │  ├─ ipc/
│  │  │  ├─ router.ts            # channel → handler dispatch
│  │  │  └─ validate.ts          # hand-written boundary validators
│  │  ├─ db/
│  │  │  ├─ driver-pg.ts         # the ONLY file importing 'pg'; type parsers live here
│  │  │  ├─ connection-manager.ts # one pool per connection, lazy, deduped, teardown
│  │  │  ├─ query-service.ts     # run / window / sort / cancel / dispose
│  │  │  ├─ schema-service.ts    # catalog reads + per-connection cache
│  │  │  ├─ result-registry.ts   # bounded count, TTL, LRU, memory cap
│  │  │  ├─ result-sql.ts        # cursor, keyset and OFFSET statement builders
│  │  │  ├─ introspect.ts        # pg_catalog queries + row mappers
│  │  │  ├─ sql-scan.ts          # Postgres lexical scanner (single-statement proof)
│  │  │  ├─ ident.ts             # quoteIdent / isGeneratedName
│  │  │  ├─ session.ts           # the SET statements applied to every backend
│  │  │  ├─ pg-config.ts         # StoredConnection → pool config, SSL mapping
│  │  │  ├─ pg-error.ts          # SQLSTATE + errno → TabbyError
│  │  │  ├─ row-shape.ts         # positional rows → keyed records
│  │  │  └─ services.ts          # one wiring point for app and harness
│  │  ├─ store/                  # settings JSON + safeStorage
│  │  └─ export/                 # streamed CSV/JSON/SQL writers (Phase 8)
│  ├─ preload/
│  │  └─ index.ts
│  ├─ renderer/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ app/                  # shell, routing, layout
│  │     ├─ components/           # SchemaTree, QueryConsole, ResultTabs…
│  │     ├─ grid/                 # ◄── see GRID-SPEC.md; imports nothing above
│  │     ├─ sql/                  # lexer, splitter, highlighter (Phase 7)
│  │     ├─ stores/               # pinia
│  │     └─ styles/
│  └─ shared/                     # imported by ALL THREE processes
│     ├─ ipc-contract.ts          # channel names + request/response types
│     ├─ domain.ts                # StoredConnection, TableMeta, EncodedRowBlock…
│     ├─ columnar.ts              # the transfer codec: main encodes, renderer decodes
│     ├─ pg-types.ts              # OID table, encoding choice, value normalisation
│     └─ errors.ts                # tagged error union
└─ tests/
   ├─ unit/
   └─ integration/                # requires a live Postgres; skips when unconfigured
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

One `pg.Pool` per saved connection. Connect lazily; verify with a cheap `SELECT 1`; tear down on window close and on idle timeout.

Pool size is `MAX_CONCURRENT_CURSORS (4) + RESERVED_CANCEL_CONNECTIONS (1) + AUX_CONNECTIONS (2) = 7`.

> **Correction (Phase 4).** This section originally specified `max: 2` — "one for queries, one
> reserved for `pg_cancel_backend`". That deadlocks. Every live result holds its client for as long as
> its tab is open, so four results plus the reserved cancel client leave nothing for catalog reads or
> the background count, and the next schema-tree expansion queues behind a cursor that will not be
> released. The two auxiliary slots are what keep the UI responsive while results are open.

On every new client the pool creates — attached to the pool's `connect` event, because clients are
created lazily and hardening only the first one would leave a writable backend behind:

```sql
SET default_transaction_read_only = on;
SET statement_timeout = 30000;
SET idle_in_transaction_session_timeout = 60000;
SET lock_timeout = 5000;
SET client_encoding = 'UTF8';
SET DateStyle = 'ISO, MDY';
SET timezone = 'UTC';          -- normalise; convert for display in the renderer
SET application_name = 'tabby';
```

Sent as **one multi-statement simple query, enqueued synchronously** inside the `connect` handler.

> **Correction (Phase 4).** Both details were bugs, not style. A `.then()` chain defers the first
> `client.query()` to a microtask, and pg-pool resolves the waiting caller in the same tick — so a
> caller's query could be queued _ahead_ of the SETs. Observed against a live server:
> `current_setting('TimeZone')` returned `Asia/Jakarta` on a connection that had already reported
> read-only mode as `on`. Timeouts are bare integers (Postgres documents these three settings in
> milliseconds) rather than `'30s'`, so there is no unit string to misparse.

`default_transaction_read_only` is the **real** v1 safety guarantee: it is enforced by Postgres, so a bug in our SQL construction cannot write. A test asserts that an `INSERT` over a Tabby connection fails with SQLSTATE `25006` (`read_only_sql_transaction`) — and, in `tests/integration/`, that so do `UPDATE`, `DELETE`, `CREATE`, `DROP` and `TRUNCATE`. Recommend users also connect with a read-only role.

Known interaction: `idle_in_transaction_session_timeout` (60s) is shorter than the result registry's
TTL (10 min), so a **cursor** result can be killed by the server for idleness before the registry
evicts it. That surfaces as `CURSOR_CLOSED` ("result expired — re-run query"). Browse mode is immune
because it holds no transaction open.

### 5.2 Positionable large results

`OFFSET 900000` makes Postgres scan and discard 900k rows — scrolling to the bottom of a big table would take seconds. Use a server-side cursor instead:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
DECLARE tabby_c_<resultId> NO SCROLL CURSOR FOR <query>;
FETCH 1000 FROM tabby_c_<resultId>;         -- first window
MOVE ABSOLUTE 900000 IN tabby_c_<resultId>; -- forward jump
FETCH 1000 FROM tabby_c_<resultId>;
```

`NO SCROLL` is deliberate — bidirectional cursors force Postgres to materialise the whole result.

> **Correction (Phase 4), and the most important one in this document.** The original text claimed
> "the grid only ever moves forward plus jumps, which `MOVE ABSOLUTE` covers." **That is false, and
> the failure mode is severe.** Verified against PostgreSQL 18:
>
> ```
> MOVE ABSOLUTE 10 IN c;   -- after having fetched past row 100
> ERROR:  cursor can only scan forward
> HINT:  Declare it with SCROLL option to enable backward scan.
> ERROR:  current transaction is aborted, commands ignored until end of transaction block
> ```
>
> A user scrolling _up_ therefore kills the result outright, not merely fails one request. The fix is
> to close and re-declare the cursor inside the **same** transaction and then `MOVE ABSOLUTE` forward
> to the target. That is why the transaction is `REPEATABLE READ`: the re-declared cursor reads the
> same snapshot, so rows do not shift under the user between jumps. Measured cost of a backward jump
> to row 10 on a 10M-row result: **1.1ms**.

Trade-off to manage: the cursor holds a transaction open, which pins xmin and can cause table bloat on a busy production database. Mitigations: `idle_in_transaction_session_timeout`, aggressive cursor close on tab disposal, TTL + LRU eviction in the registry, and — when a table has a usable key — **browse mode**, which needs no open transaction at all.

Browse mode is the default when the query is a plain scan of one table with a usable key:

- sequential window → keyset seek: `WHERE (a,b) > ($1,$2) ORDER BY a,b LIMIT n`
- arbitrary jump → `ORDER BY a,b LIMIT n OFFSET k` (still index-ordered, still no open transaction)

The renderer supplies only `{schema, table}`; main resolves the key columns from the catalog. Which
columns identify a row is a correctness decision, not a renderer choice. A unique index over a
**nullable** column is rejected as a key, because `NULL` never equals `NULL` and the seek predicate
could skip or repeat rows. Measured: an `OFFSET` jump to row 5,000,000 costs **373ms** — honest O(n),
but with no xmin pinned while the user reads.

### 5.3 `ResultRegistry`

`resultId` → `{ cursor | keysetState, columns, rowCount, lastAccess, bytesHeld }`.

- Max concurrent results (default 20), TTL (default 10 min idle), total memory cap (default 512 MB)
- LRU eviction emits `evResultEvicted` so the renderer can show "result expired — re-run query" instead of blank cells
- Disposed on tab close and on connection loss

The clock is injected, so TTL and eviction are testable in microseconds. `bytesHeld` counts only what
main actually retains — the eager prefetch — not the encoded blocks it hands to the renderer and
drops; charging transient blocks would evict live results for memory that was never held.

> **Correction (Phase 4).** `QueryService` takes registry **bounds**, not a registry instance.
> Eviction is what closes a cursor and returns its pooled client, and that cleanup is wired through
> `onEvict` at construction. Accepting an injected registry meant a caller-supplied instance carried
> the caller's callback, so every eviction silently leaked a client until the pool was exhausted —
> which presented as "timeout exceeded when trying to connect" after a dozen results. Bounds are
> injectable; ownership is not.

### 5.4 Columnar transfer codec

Shipping 1M JS row objects across `contextBridge` is slow and memory-hungry. Instead send column-major typed arrays:

- `int2/int4/float4/float8`, `timestamp/timestamptz` → `Float64Array` + a bit-packed `nulls: Uint8Array`
- `int8/numeric` → **text** in a flat `Uint32Array` offset table + one `Uint8Array` UTF-8 blob (a double cannot hold them)
- `text/varchar/json/date/bytea` and every unknown OID → same offset-table + blob approach
- `bool` → bit-packed `Uint8Array`

Decode lazily in the renderer into `CellValue` per _visible_ cell only. Never decode a whole block eagerly.

Lives in **`src/shared/columnar.ts`**, not in main: main encodes and the renderer decodes, so the two
halves must agree by construction rather than by duplicated constants. The type knowledge it depends
on (`src/shared/pg-types.ts` — OID table, encoding choice, width hints, value normalisation) is shared
for the same reason and is itself dependency-free.

Two invariants, both silent-failure bugs otherwise: `offsets` are **byte** offsets into the UTF-8 blob
(slicing on a character count cuts a multi-byte code point in half), and a column whose preferred
encoding cannot represent one of its values **degrades to `utf8`** rather than losing the value.

**Type parsers.** `driver-pg.ts` overrides eight of `pg`'s defaults, all verified against a live
server:

| OID                        | `pg` default                            | Tabby                | Why                                                                        |
| -------------------------- | --------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `timestamp` (1114)         | `Date` in the **host** timezone         | epoch ms read as UTC | The same row rendered 7 hours apart on this machine                        |
| `date` (1082)              | `Date` at local midnight                | the calendar text    | A date has no timezone; any `Date` is midnight _somewhere_                 |
| `json`/`jsonb` (114, 3802) | parsed JS object                        | the server's text    | Re-stringifying loses key order, spacing, and numbers a double cannot hold |
| `interval` (1186)          | `{days:1,hours:2,…}`                    | the server's text    | Not what psql shows, and there is no arithmetic to do on it                |
| `time`/`timetz`/`money`    | `Date` anchored at 1970 / stripped text | the server's text    | Same reason                                                                |

Keeping json as text also makes a JS array unambiguous: it can only have come from a Postgres array
type, which is what lets the codec render `{1,2}` (pastes back into SQL) instead of `[1,2]`.

### 5.5 Cancellation

Capture `pg_backend_pid()` when a client is acquired, store it against the `resultId`, and issue `SELECT pg_cancel_backend($1)` on the **reserved second connection**. Cancelling on the busy connection is impossible — it is blocked waiting for the server.

The pid is read once per acquired client, not per fetch: it identifies the backend running _that_
client's query. Measured round trip: **2.8ms**.

### 5.6 Identifier safety

Two functions with two contracts, because one rule cannot serve both:

- **`quoteIdent(name)`** — for names that came from a catalog row or the renderer. Always wraps in
  `"`, doubles any embedded `"`, and refuses the two things Postgres cannot represent: a NUL byte
  (which truncates the name server-side) and anything over NAMEDATALEN-1 = 63 **bytes**.
- **`isGeneratedName(name)` / `assertGeneratedName`** — the `[A-Za-z_][A-Za-z0-9_$]*` allowlist, for
  names Tabby invents (cursor names). These never need quoting, and asserting it means a bug in name
  generation fails loudly instead of producing malformed DDL.

> **Correction (Phase 4).** This section originally proposed one rule: reject anything outside
> `[A-Za-z0-9_$]`, then double any embedded `"`. Those two halves contradict each other (an allowlist
> admits no `"` to double), and the allowlist is wrong for names that came from the server. Postgres
> happily stores `Mixed Case`, `has space`, `with"dquote` and `unicode_ünïcødé`; refusing them makes
> real databases unbrowsable without making anything safer. All four are in the fixtures and all four
> round-trip through a real query.

All _values_ go through `pg`'s parameter binding (`$1, $2`), never string interpolation. Renderer-supplied SQL that is wrapped in `DECLARE … CURSOR FOR` additionally passes through the lexical scanner in `sql-scan.ts`, because a trailing `; DROP TABLE x` would otherwise leave the wrapper as two statements on the simple-query protocol.

---

## 6. Designed-in for v2 editing (declarations only — nothing implemented)

> **Accuracy note (updated at Phase 4).** `RowKey`, `Change`, `RowIdentityResolver` and `ChangeBuffer`
> are now **declared** at the bottom of `src/shared/domain.ts`, as PLAN Phase 4 specified. They are
> declarations and nothing else: there is no implementation anywhere, no editor, no write path, no
> change tracking, and v1 remains read-only. A grep of `src/**` for `beginEdit|commitEdit|setCell|editable`
> still returns zero matches, and the only implementations of these interfaces are the ones Phase 10
> will write.
>
> What Phase 4 _did_ add, because it was already reading the catalogs:
> `TableMeta.primaryKey` is populated from `pg_index`, and `TableMeta.uniqueIndexes` carries every
> unique index with an `allColumnsNotNull` flag — the input the resolver will need.
> `SchemaService.paginationKeyFor()` picks a key for `ORDER BY`/`WHERE` in a read-only `SELECT`. It is
> **not** `RowIdentityResolver.resolve()`: paging is a performance decision, row identity is a write
> decision with stricter rules, and conflating them is how a viewer ends up updating the wrong row.
>
> The guard rails still hold and are tested: `default_transaction_read_only` is on for every backend,
> and `tests/integration/` asserts that `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP` and `TRUNCATE`
> all fail with SQLSTATE `25006` and that the probe table stays empty.

```ts
// Row identity: which columns uniquely pin a row, so an UPDATE can target it.
type RowKey = readonly { readonly column: string; readonly value: CellValue }[];

interface RowIdentityResolver {
  /** Primary key if there is one, else the best unique NOT NULL index, else null. */
  resolve(table: TableMeta): readonly string[] | null;
  keyOf(table: TableMeta, row: RowBlock, offset: number): RowKey | null;
}

// Staged edits, held in the renderer, flushed as parameterised SQL built in MAIN.
interface Change {
  readonly column: string;
  readonly before: CellValue; // for the optimistic-concurrency WHERE clause
  readonly after: CellValue;
}

interface ChangeBuffer {
  set(resultId: string, row: RowKey, col: string, next: CellValue): void;
  revert(resultId: string, row: RowKey, col?: string): void;
  changesFor(row: RowKey): readonly Change[];
  /** Built in the main process only, always parameterised. */
  toSql(): readonly { text: string; values: readonly unknown[] }[];
}
```

Two things this design commits to, because they are hard to retrofit:

1. **`TableMeta.primaryKey` already exists** (`src/shared/domain.ts`) and Phase 4 fills it from
   `pg_constraint`/`pg_index`. That is the only piece of editing groundwork genuinely in place today,
   and it is why the type declarations belong in Phase 4 rather than Phase 10 — the metadata is
   already being read there.
2. **A table with no usable unique index is not editable.** `resolve()` returns null and the grid must
   render those columns read-only rather than guessing with a full-row `WHERE`. Silent
   multi-row updates are the worst failure mode an editing UI can have.

Editing additionally requires dropping `default_transaction_read_only` **per-transaction** (never
per-connection, so a failed write cannot leave the session writable) and an optimistic-concurrency
check (`WHERE pk = $1 AND col IS NOT DISTINCT FROM $2`).

On the grid side the additions are all additive, which is the point of the `DataSource` boundary:
a mutable `DataSource` variant with a write method, an `editable`/`readOnly` flag on `ColumnSpec`,
`beginEdit`/`commitEdit`/`cancelEdit` on `SelectionEvent`, and a real editor mounted on the existing
`overlay` canvas layer — which today only draws the column-resize guide.

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
