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
│  │  │  ├─ ddl.ts               # CREATE TABLE / VIEW + COMMENT ON generation (Phase 6)
│  │  │  ├─ sql-scan.ts          # Postgres lexical scanner (single-statement proof)
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
│  │     ├─ components/           # ConnectionBar, QueryEditor, ResultStatus, TabBar,
│  │     │                        #   SchemaTree, TableDetail, TreeMenu…
│  │     ├─ data/                 # RemoteDataSource, and the invoke() wrapper
│  │     ├─ grid/                 # ◄── see GRID-SPEC.md; imports nothing above
│  │     ├─ schema/               # tree-model: pure flatten/window/filter/keys (Phase 6)
│  │     ├─ sql/                  # highlight layer; the lexer + splitter are in shared/
│  │     ├─ stores/               # pinia: tabs, connections, results, schema
│  │     └─ styles/
│  └─ shared/                     # imported by ALL THREE processes
│     ├─ ipc-contract.ts          # channel names, request/response types, MainEventMap
│     ├─ domain.ts                # StoredConnection, TableMeta, EncodedRowBlock…
│     ├─ columnar.ts              # the transfer codec: main encodes, renderer decodes
│     ├─ pg-types.ts              # OID table, encoding choice, value normalisation
│     ├─ ident.ts                 # quoteIdent — main quotes, renderer builds browse SQL
│     ├─ sql-lexer.ts             # Postgres §4.1 tokenizer; tiling, never throws
│     ├─ sql-split.ts             # statement splitter + caret/selection resolution
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
  schemaChildren: 'schema:children', // (connectionId, parentSchema|null) → one level
  schemaTable: 'schema:table', // columns, indexes, constraints, ddl → TableDetail
  schemaRefresh: 'schema:refresh', // → number of cache entries dropped

  // queries
  queryRun: 'query:run', // → { resultId } immediately
  queryCancel: 'query:cancel',

  // results (windowed — never ship a whole result set)
  resultMeta: 'result:meta', // columns + rowCountEstimate
  resultWindow: 'result:window', // (resultId, startRow, rowCount) → columnar batch
  resultSort: 'result:sort', // server-side re-query, never a local reorder
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
- **The schema is read one level at a time.** `schema:children` takes a `parentSchema` (`null` for the
  schema list) and returns exactly one level.

> **Correction (Phase 6).** This section originally declared `schemaTree: 'schema:tree'`, a whole-tree
> read. That does not survive contact with a real database: a server with 200 schemas × 2,000 tables
> would ship hundreds of thousands of `SchemaNode`s across the bridge before the user could expand a
> single folder. The channel is `schema:children`, the renderer loads a node when its caret is first
> opened, and `SchemaService` caches per `(connection, parentSchema)` until an explicit
> `schema:refresh`.

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

| Implementation       | Used in              | Notes                                                                                    |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `FakeDataSource`     | unit tests, demo tab | Deterministic 1M×30 synthetic rows. Lets the grid be finished before any DB code exists. |
| `RemoteDataSource`   | Phase 5+             | Wraps IPC. Owns retry/backoff and terminal states — see the correction below.            |
| `InMemoryDataSource` | Small results, tests | Whole result already local. Not built yet; nothing has needed it.                        |

Phase 5's exit criterion was that the grid's own API and tests do **not** change when `Fake` is swapped for `Remote`. It held: `git diff --stat HEAD -- src/renderer/src/grid tests/unit/grid-*.spec.ts` is empty. If a future change needs the grid to move, that is the signal the boundary was wrong — fix the boundary, not the grid.

> **Correction (Phase 5): the prefetch/dedupe/abort row above was wrong.**
>
> This section described `RemoteDataSource` as owning "read-ahead prefetch, in-flight
> dedupe, stale-response abort". All three already lived in the grid's
> `DataWindowController`, built in Phase 1, and they _must_ stay there — it is the only
> component that knows the visible range. A second copy in the source would mean two
> components racing to decide what to fetch. So `getBlock` is one honest request per
> call. "Loading skeletons" were likewise already done: `paint.ts` draws
> `theme.placeholder` for any cell the cache does not have.
>
> What the grid genuinely cannot own is **retry policy**. `DataWindowController.request()`
> re-asks for any block that is neither cached nor in flight, and `update()` runs every
> frame — so a range that fails permanently is re-requested 60 times a second, forever.
> Against a server that has gone away that is a retry storm the user can neither see nor
> stop. `RemoteDataSource` therefore owns backoff (250ms → 8s, five attempts, per range),
> and four **terminal** states in which no retry can help — evicted, cursor closed,
> cancelled, connection lost — after which it stops calling the bridge entirely.
>
> Two smaller things worth recording, because both were invisible until something needed
> them:
>
> - The grid reads `source.rowCount` and `source.columns` on every frame, so they are
>   getters, not snapshots. A background `count(*)` landing only has to update the source
>   and call `invalidate()`.
> - `run()` prefetches rows eagerly to learn the column metadata. Those rows are kept and
>   served to the first windows; discarding them would make the first
>   `getBlock(0, …)` a _backward_ jump, which on a cursor means re-running the query.

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

### 5.7 The catalog detail read and generated DDL (Phase 6)

`schema:table` returns a `TableDetail`, not a `TableMeta`. The distinction is a performance decision,
not a naming one:

| Object        | Contents                                           | Cached in     | On the hot path?                                             |
| ------------- | -------------------------------------------------- | ------------- | ------------------------------------------------------------ |
| `TableMeta`   | columns, `primaryKey`, `uniqueIndexes`, estimate   | `tableCache`  | **Yes** — `paginationKeyFor` reads it for every browse query |
| `TableDetail` | `meta` + every index + constraints + generated DDL | `detailCache` | No — only when the detail pane opens                         |

Folding the extra three catalog reads into `tableOf` would have taxed every table open to pay for a
pane the user may never click. All three caches are dropped together by `SchemaService.refresh()`.

**Two index queries, on purpose.** `INDEXES_SQL` aggregates `indkey` into a column list and therefore
_must_ exclude expression indexes (their `indkey` entries are zero) and partial indexes ("unique among
rows matching a predicate" cannot identify a row). Those exclusions are a correctness property of row
identity. `INDEX_DEFS_SQL` has the opposite requirement — hiding a partial unique index would hide the
reason a duplicate insert was rejected — so it reads the server's own `pg_get_indexdef` text, which
renders expressions and predicates correctly. `fixtures.detail_sample` carries a partial unique index
precisely so one fixture pins both answers.

**`pg_get_*` text is embedded verbatim, never rebuilt.** Re-deriving a constraint from
`conkey`/`confkey` would mean reconstructing column order, match type, operator classes and the
referential actions — all of which the server already renders in a form guaranteed to re-parse.

> **Correction (Phase 6).** This section originally claimed the definitions "are exactly what `\d+`
> prints". They are not. `psql` reformats both functions: it prints `CHECK (amount >= 0::numeric)`
> where `pg_get_constraintdef` returns `CHECK ((amount >= (0)::numeric))`, and reduces an index to
> `btree (lower(code::text))` where `pg_get_indexdef` returns the whole
> `CREATE INDEX … USING btree (lower((code)::text))`. Two integration assertions written from real
> `\d+` output failed against the live server. Tabby shows the catalog functions' text.

`createDdl` in `src/main/db/ddl.ts` is a **reading aid, not a migration tool**. It emits `CREATE TABLE`
plus `COMMENT ON`s for a table, `CREATE [MATERIALIZED] VIEW` from `pg_get_viewdef` for a view, and
**nothing** for a sequence — `create sequence "s"."x";` would be valid and silently wrong, dropping the
start, increment, bounds and cache Phase 6 does not read. An empty result is honest; a
plausible-looking statement is not. Every identifier goes through `quoteIdent`, so a table literally
named `x"; drop table users; --` produces a `CREATE TABLE` for that name and nothing else. Comments go
through `quoteLiteral`, which switches to the `E'…'` form whenever the text contains a backslash or a
control character, so the literal denotes the same thing whether or not a session has turned
`standard_conforming_strings` off.

**PostgreSQL 18 note.** 18 stores `NOT NULL` in `pg_constraint` as `contype = 'n'`, and `\d+` grew a
"Not-null constraints" section for it. `constraintKindFor` maps `p/u/f/c/x` and returns `null` for
everything else, so those rows are dropped: the Nullable column already carries the information, and
rendering both would show every NOT NULL column twice.

### 5.8 The virtualised schema tree (Phase 6)

Hand-built in `src/renderer/src/schema/tree-model.ts`. It reuses the grid's windowing **concept** and
none of its code — the grid is a canvas with frozen columns and a two-axis extent, the tree is a
one-axis list of DOM rows, and `@/schema` imports nothing from `@/grid`.

The split that makes 2,000 relations scroll smoothly:

| Function        | Runs when                               | Cost                                             |
| --------------- | --------------------------------------- | ------------------------------------------------ |
| `flattenRows`   | the tree's _contents_ change            | O(nodes), and only **expanded** nodes are walked |
| `virtualWindow` | the scroll offset changed — every frame | **O(1)** in the row count                        |

A scroll therefore never re-walks the tree, and the cost of scrolling a 2,000-relation schema is
identical to the cost of scrolling a 20-relation one. The unit test asserts this structurally
(`virtualWindow` returns the same window for 2,000 and 200,000 rows), and the bench harness measures it
through the real scroller.

Node ids join their segments with `\u0000`. A Postgres identifier cannot contain NUL — `quoteIdent`
refuses it — so `childNodeId` is injective and `a.b` as one name can never collide with `a` + `b` as
two. Any printable separator would allow that collision.

Accessibility is the standard virtualised-list compromise, stated rather than hidden: rows outside the
window are not in the DOM, so each `treeitem` carries `aria-level`, `aria-posinset` and `aria-setsize`
to describe its true position in a list the renderer can only see part of. Nesting is conveyed by
`aria-level` rather than by nested `role="group"` elements, because the DOM is deliberately flat; the
spacer and slice wrappers are `role="presentation"` so they do not break the `tree` → `treeitem`
ownership chain. **No human VoiceOver pass has been done.**

### 5.9 One lexer, two consumers (Phase 7)

`src/shared/sql-lexer.ts` tokenizes Postgres SQL per §4.1 of the manual. It lives in `shared` because
two consumers need the _same_ answer and must not be allowed to drift:

| Consumer                            | Question it answers                                 | Consequence of being wrong                                 |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `src/main/db/sql-scan.ts`           | may this text be wrapped in `DECLARE … CURSOR FOR`? | a second statement runs on the simple-query protocol       |
| `src/renderer/src/sql/highlight.ts` | which characters get which colour?                  | the editor colours a keyword inside a string literal       |
| `src/shared/sql-split.ts`           | where does one statement end and the next begin?    | the console sends a fragment of a function body as a query |

Before Phase 7 the scanner held its own hand-rolled loop. Rebuilding it on the shared lexer — with its
**31 pre-existing tests untouched and still passing** — is what makes the three rows above one row. A
splitter and a validator that disagree would surface as the server rejecting a statement the UI had
just split confidently, which reads like a Postgres bug and is not.

Three properties the lexer holds that its consumers rely on:

- **Tokens tile the input.** Every character is in exactly one token, in order, with no gaps or
  overlaps. Asserted over a 45-input corpus rather than once, because a gap is unstyled text and an
  overlap is text rendered twice — both invisible in a screenshot of a query that happens not to hit
  the case.
- **It never throws.** A half-typed query is the normal state of an editor, so an unterminated
  construct is reported in `error` and its token runs to end of input. `sql-scan.ts` is the caller that
  _must_ refuse such input, and it converts the report into a thrown `SqlStructureError`.
- **The NUL check runs before lexing, not during.** Postgres rejects a NUL anywhere in the query text
  because that text is a C string, so one buried inside a literal is just as fatal as one at top level.
  Reporting the literal as "unterminated" instead would send the user to fix the wrong thing.

`highlight.ts` renders those tokens to HTML for the `<pre>` behind a transparent-text `<textarea>`. Two
rules make that safe and correct:

- It escapes `&`, `<` and `>` — the output is assigned to `innerHTML`, so escaping is a security
  boundary, not a nicety. The `vue/no-v-html` rule is disabled for that one file in `eslint.config.mjs`
  with the justification recorded there.
- It escapes `\r` as `&#13;`. **Chromium's HTML parser normalizes a bare carriage return away and
  happy-dom does not**, so `innerHTML = 'a\r\nb'` yields a 3-character text node where the textarea
  holds 4. A Windows-line-ending paste would offset every line after the first, and no unit test in
  this repository could catch it. The smoke harness asserts the two layers are character-identical for
  a CRLF script in the real renderer, which is the only place it can be proved.

### 5.10 Cancelling a run that has not registered yet (Phase 7)

`QueryService` puts a result in the registry only after its first page has arrived. That is the right
time to start accounting for its memory — and it means a runaway query, which by definition has
produced no rows, is not in the registry and cannot be cancelled by id. `cancel` answered
`RESULT_NOT_FOUND` for exactly the queries the Cancel button exists for.

`pendingRuns` closes the gap: the id is recorded before the `planning` progress event is emitted, and
the backend pid is filled in as soon as a client is acquired. The renderer learns the id from that
event, which is the only channel it has — the `queryRun` call is still awaiting. Cancelling an
unregistered run measures **1.1ms** against a live server, and the client returns to the pool.

There is one window where cancellation genuinely cannot work: between `run()` starting and the client
being acquired, there is no backend to signal. That returns
`NOT_FOUND: the query has not reached the server yet` rather than reporting success for a cancel that
could not have reached anything.

### 5.11 A checked-out client needs its own `error` listener (Phase 8)

`pg`'s `Pool` emits `'error'` for **idle** clients only, and `createPgDriver` has always handled that.
A client handed out by `acquire()` is no longer idle, so its errors go to the client's own
`EventEmitter` — and an `'error'` event with no listener is rethrown by Node as an uncaught exception,
which takes the whole main process down.

The trigger is not exotic. A result tab holds a `REPEATABLE READ` transaction open for as long as the
user leaves it on screen, and `idle_in_transaction_session_timeout` is 60s (§5.1). Leave a query result
sitting for a minute and the server terminates the backend: an ordinary, documented event that was
fatal. `acquire()` now attaches a listener that records the failure — so subsequent `query()` calls
reject immediately instead of queueing onto a socket the server has already closed — and returns the
pool slot, because holding a client for a dead backend would leak one of the four.

Found by the smoke harness, and only after the harness was taught to print a crash instead of hanging:
before that, an unhandled rejection inside `app.whenReady().then(…)` left Electron running with no
window logic left to exit, and ten minutes of wall clock produced **no output at all**.

### 5.12 Streamed export: rows never cross the bridge (Phase 8)

PLAN's exit criterion is a memory budget on the _renderer_, and the design meets it structurally
rather than by tuning. `ExportService` reads a batch from **its own** cursor, serialises it, writes it
to a `WriteStream`, and drops it. The renderer's entire view of an export is
`{rowsWritten, bytesWritten, phase}` on `event:export-progress`. Measured: 1M rows → 33.4MB in 12.2s
with **−0.5MB** retained in main, and a 200k-row export through the real UI moving the renderer heap
by **0MB**.

Four rules follow from that, and each is load-bearing:

- **Its own client and cursor.** `QueryService.exportDescription(resultId)` returns the connection, the
  full statement and the columns — a _description_, never the live cursor. Exporting through the
  result's own cursor would advance a `NO SCROLL` cursor the grid is paging with and leave the tab
  showing rows it no longer has. The cost is a second pooled slot and a second snapshot, so a file
  exported while the table is being written can differ from what was on screen. A live test asserts the
  grid's cursor still works — including a backward jump — after its result has been exported.
- **For a browse result the exported statement is `baseSql`, not `sql`.** `state.sql` for an unpaged
  browse is the _keyset page_, carrying its `LIMIT`; exporting that would write `initialRows` rows and
  call it the table. Once the user sorts, the result becomes a cursor and `state.sql` is already the
  full sorted query, so the branch is exactly "is this still an unpaged browse".
- **Backpressure is honoured.** `write()` awaits `'drain'` when `writableNeedDrain` says so. Ignoring it
  would let a slow disk become an unbounded Node write buffer — which is how a "streaming" export ends
  up holding the whole result in memory anyway, and would pass every row-count assertion.
- **A failure deletes the partial file; a cancel keeps it.** A truncated CSV that looks complete is a
  trap: a spreadsheet opens it and reports fewer rows than the query returned, with nothing to say why.
  A cancelled export is the user's own decision to stop, and discarding the rows they did get would be
  the surprising choice. The file is only deleted when the service actually created it, so failing
  _before_ the stream opens cannot remove something the user named in the dialog.

### 5.13 The destination is main's decision, and only main's

`ExportStartRequest` has **no path field**, and `exactKeys` in `validate.ts` is what enforces it. The
destination comes from `dialog.showSaveDialog`, so the only way bytes reach the disk is through a
picker the user just confirmed. Accepting a path from the renderer would let a compromised one write
anywhere the user's account can — a strictly worse posture than the one `safeStorage` gives passwords.

The smoke harness asserts this end to end: it calls `exportStart` with a smuggled
`path: '/tmp/tabby-smuggled.csv'`, and checks both that the call is refused `VALIDATION_FAILED` and
that **no file appears there**. `save-dialog.ts` is injected into `ExportService` as `pickPath`, which
is what keeps the service testable without Electron and lets both harnesses write into a throwaway
directory and read the bytes back.

`createDbServices` takes `pickPath` as a **required** dependency. A silent default — a stub returning
null, or one writing somewhere convenient — would quietly change what the app is allowed to touch;
making it required means every entry point has to decide, and the compiler lists the ones that have not.

### 5.14 Query history retention (Phase 7)

JSONL in `userData/history/`, rotated at 1 MiB into numbered siblings, of which at most three are
kept. PLAN's privacy note is why the bounds are **constants rather than settings**: history may contain
literals that are secrets, and a user-configurable "keep forever" turns a bounded local file into an
unbounded record of everything anyone ever typed. `clear` and `delete` unlink; that removes the files
from the filesystem, not from the disk platter or an SSD's wear-levelling table — the same guarantee a
browser gives, and the one the note claims.

Three rules the format depends on:

- `rotationSteps` returns its renames **oldest slot first**. The opposite order renames `history.1` onto
  `history.2` before deleting the old `history.2`, destroying a file the caller has not read.
- `truncateSql` counts **code points**, not UTF-16 units. A naive `slice` can end on a lone surrogate:
  valid JSON, unrenderable text, and a preview that looks like corruption for good SQL.
- Nothing throws. `decodeLine` returns `null` for a line it cannot read and `parseHistory` counts those
  in `skipped`, mirroring `SettingsStore`'s stance on `settings.json` — losing every remembered query
  over one truncated write is the worse outcome.

Writing history is a **side effect of a run that already happened**, so `HistoryStore.add` returns a
tagged error and never throws: a full disk must not turn a successful `SELECT` into a failed one. The
warning reaches the user on `historyList`, which is the only channel it has.

### 5.15 What cannot cross the Electron bridge (Phase 8)

`contextBridge` uses structured clone, and two things in this codebase do not survive it:

- **Typed arrays survive, but only if nothing flattens them first.** The columnar codec depends on this
  and Phase 5 verified it against real Electron rather than Node's `structuredClone`.
- **A Vue reactive Proxy does not survive.** The export dialog holds its options in a `ref`, so
  `options.value` is a Proxy; structured clone rejects it with "An object could not be cloned". Because
  `data/ipc.ts` turns any rejection into a tagged `Result`, this surfaced as `NOT_CONNECTED` — which
  reads as "main has no handler for this channel", an entirely different bug from the real one.
  `stores/exports.ts` copies the options **field by field** before sending. A spread would work today
  and would silently forward a nested proxy the day an option gained one.

No unit test can catch the second class, because a stubbed bridge accepts anything. The regression test
asserts `isReactive(sent.options) === false` explicitly, and the smoke harness is what found it.

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
