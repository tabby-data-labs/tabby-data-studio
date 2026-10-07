# Tabby

A desktop PostgreSQL database viewer with a from-scratch, Excel-like canvas data grid.

**Stack:** Electron 44 · Vue 3.5 · Vite 7 · Tailwind 4 · TypeScript 6 · `pg` (the only runtime dependency)

## The story behind this project

This project exists because of a challenge.

My English mentor told me something simple but hard: _"Practice your English often."_ Not just
studying grammar — actually using it, every day, in real situations. So I decided to do something
that would force me to speak, write, and think in English consistently: I started a YouTube channel
where I build software from scratch and explain everything along the way.

Tabby is the project for that channel. Every decision, every bug, every "why did I do that" moment
is documented on video — not polished for a tutorial, but honest and in progress. Building a
PostgreSQL viewer from scratch (including the data grid, which most people would just grab a library
for) gives me plenty to talk about: architecture, performance, security, canvas rendering, and the
kind of problems you only discover when you build something yourself.

If you found your way here from a video, welcome — this codebase is yours to explore, fork, and
learn from.

🎬 **Watch the introduction:** [The story behind Tabby](https://www.youtube.com/watch?v=S7wPbXX_Mhw&t=198s)

## Documentation

| Document                                       | Contents                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`PLAN.md`](PLAN.md)                           | Locked decisions, verified version matrix, dependency budget, scope, 10-phase roadmap, risk register     |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Process model, folder layout, IPC contract, `DataSource` boundary, `pg` data layer, security hardening   |
| [`docs/GRID-SPEC.md`](docs/GRID-SPEC.md)       | Canvas grid: layer model, layout math, render pipeline, selection, clipboard, accessibility, perf budget |
| [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md)   | Executable first build — scaffold plus the 1M-row canvas grid                                            |

## Status

**Phases 0–8 complete** — a hardened Electron shell, a from-scratch canvas data grid that scrolls
**1,000,000 rows × 30 columns at a measured 60fps** and behaves like Excel (pointer and keyboard
selection, five clipboard formats, context menu, cell inspector, ARIA proxy grid), a validated
three-process IPC contract with keychain-encrypted credentials, a **real Postgres data layer** verified
against live PostgreSQL 18, that data layer **driving the grid** (pick a connection, browse a table,
scroll 10M rows at 60fps), a **schema explorer** (hand-built virtualised tree, a detail pane that
matches `psql`'s `\d+`, generated DDL, right-click actions), a **query console** (hand-written Postgres
lexer, a statement splitter not fooled by a `;` in a string, comment or `$$` body, syntax-highlighted
editor, one tab per statement, a Cancel button that really stops a runaway query, and rotating JSONL
**query history**), and now **export & polish**: streamed CSV / TSV / JSON / SQL-`INSERT` export that
writes from main and never touches the renderer, a hand-written fuzzy **command palette**, a dark/light
**theme**, and **i18n hooks**.

_The `EXPLAIN` plan tree is the one listed deliverable still missing — Explain runs `explain (format
text)` into the grid, which is complete information but not a rendered tree. Deferred with a reason in
`PLAN.md` §Phase 7, not quietly dropped._

| Check                         | Result                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run deps:check`          | ✅ runtime deps = `pg@8.23.0` only                                                                                                                                                                                                          |
| `npm run lint`                | ✅ 0 errors, 0 warnings                                                                                                                                                                                                                     |
| `npm run typecheck`           | ✅ node + web projects                                                                                                                                                                                                                      |
| `npm test`                    | ✅ **1,746 tests**, 57 files (the 64 integration tests skip when no database is configured)                                                                                                                                                 |
| `npm run test:pg`             | ✅ **64 tests** against live PostgreSQL 18.6 — read-only enforcement, cursor jumps, cancelling a run that has not registered, type fidelity, `\d+` fidelity, registry soak, **and a 1M-row export**                                         |
| `npm run i18n:check`          | ✅ 47 catalogue keys, **63 `t()` call sites**, no missing keys                                                                                                                                                                              |
| `npm run build`               | ✅ main (3 entries) · preload · renderer                                                                                                                                                                                                    |
| `npm run smoke` (prod CSP)    | ✅ **108/108 assertions** — paints, `eval` + inline scripts **blocked**, keyboard nav, copy, IPC round-trip, **13/13 hostile payloads rejected** (8 IPC + 5 history), explorer + editor + history + palette + theme all mount clean         |
| `npm run smoke:dev` (dev CSP) | ✅ **108/108** — both correctly **allowed** under the dev policy                                                                                                                                                                            |
| `npm run smoke` + a database  | ✅ **149/149** — adds the columnar codec and catalog payload across _Electron's_ serializer, cancels a real `pg_sleep(60)` **through the UI**, refuses a **smuggled export path**, and exports 200k rows with a **0MB** renderer-heap delta |
| `npm run bench` (grid)        | ✅ live 10M×4: p95 **3.30ms** · **59.9 fps** · 10ms budget                                                                                                                                                                                  |
| `npm run bench` (tree)        | ✅ **2,025 rows in the tree, 26 elements in the DOM** — p95 **1.90ms** per frame, **59.9 fps**, 0 dropped over 600 frames (8ms / 55fps budget)                                                                                              |

Runtime confirmed as **Electron 44.4.5 / Chromium 152.0.7977.130 / Node 24.21.0**, with no
`require`, `process`, `Buffer`, or `ipcRenderer` leaking into the renderer, `window.tabby` frozen,
and a one-entry permission allowlist (`clipboard-sanitized-write`) that denies everything else.

Passwords are stored as `safeStorage` ciphertext and refused outright when no OS keychain is
available — never written in plaintext as a fallback. Every log line passes through a redactor, and
error text crossing IPC is scrubbed of credentials and connection URIs.

**Every connection is read-only at the server**, not merely in our code: `SET
default_transaction_read_only = on` is applied to each backend the pool creates, and the integration
suite asserts that `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP` and `TRUNCATE` all fail with
SQLSTATE `25006`. Measured against a 10M-row / 789 MB table: first 1000 rows in **19.1ms**, a forward
jump to row 800,000 in **63ms**, a backward jump in **1.1ms**, `pg_cancel_backend` in **2.8ms**.

**The grid boundary held — twice.** Phase 5 swapped the synthetic source for an IPC-backed one, and
Phase 6 added a whole sidebar next to it, without changing a byte of the grid:
`git diff --stat HEAD -- src/renderer/src/grid tests/unit/grid-*.spec.ts` is empty. The 22 modules /
~5,000 lines in `src/renderer/src/grid/` import nothing from the app — enforced by an ESLint rule —
and `pg` is imported by exactly one file, `src/main/db/driver-pg.ts`, enforced the same way.

What the grid could _not_ own turned out to be retry policy: `DataWindowController` re-requests any
block that is neither cached nor in flight, every frame, so a permanently failing range would be
re-requested 60 times a second forever. `RemoteDataSource` holds the backoff (250ms → 8s, five
attempts) and the terminal states — evicted, cancelled, cursor closed, connection lost — and the UI
offers an explicit Retry rather than hammering a server that has gone away.

**The schema tree reuses the grid's windowing _concept_ and none of its code.** The grid is a canvas
with frozen columns and a two-axis scroll extent; a tree is a one-axis list of DOM rows. What carries
over is the split that makes both fast: `flattenRows` runs when the tree's _contents_ change, and
`virtualWindow` — **O(1) in the row count** — runs on every scroll frame. Scrolling a 2,000-relation
schema therefore costs exactly what scrolling a 20-relation one costs. A unit test asserts that
structurally; the bench measures it through the real scroller.

**`psql`'s `\d+` is not `pg_get_*` output.** Phase 6 aimed the detail pane at `\d+` fidelity and the
live server disagreed: psql _reformats_ both catalog functions, printing `CHECK (amount >= 0::numeric)`
where `pg_get_constraintdef` returns `CHECK ((amount >= (0)::numeric))`, and reducing an index to
`btree (lower(code::text))` where `pg_get_indexdef` returns the whole `CREATE INDEX` statement. Two
integration assertions written from real `\d+` output failed. Tabby shows the catalog functions' text —
it is the form guaranteed to re-parse when pasted back — and the four deliberate divergences from
`\d+` are listed in `PLAN.md` and in `TableDetail.vue`'s header rather than glossed over. PostgreSQL 18
also stores `NOT NULL` in `pg_constraint`; those rows are dropped, because the Nullable column already
says it and listing both would show every column twice.

**One lexer, two consumers.** The editor's statement splitter and main's `assertSingleStatement` — the
security control that decides whether renderer-supplied SQL may be wrapped in `DECLARE … CURSOR FOR` —
now read the _same_ tokenizer in `src/shared/sql-lexer.ts`. Before Phase 7 main had its own hand-rolled
loop. Rebuilding it on the shared lexer left its **31 pre-existing tests untouched and still passing**,
which is the proof that the two cannot drift: a splitter and a validator that disagree would surface as
the server rejecting a statement the UI had just split confidently, and that reads like a Postgres bug.

**Chromium deletes a bare `\r` in parsed HTML; happy-dom does not.** Measured in Electron, not
recalled: `innerHTML = 'a\r\nb'` yields a 3-character text node, `'a&#13;\nb'` yields 4. Without
escaping the carriage return, a script pasted with Windows line endings would make the highlight layer
one character shorter per line than the textarea stacked on top of it — every following line visibly
offset — and **no unit test in this repository could ever have caught it**, because the test
environment does not normalize. The smoke harness now asserts the two layers are character-identical
for a CRLF script in the real renderer.

**Both Electron harnesses were running with `emit: () => undefined`.** The comment said "the harness
polls", which was true until the Cancel button needed the `planning` progress event as its only source
of the in-flight result id. The harnesses were therefore measuring a renderer that could never receive
an eviction, a connection-lost or a progress notice — three shipping code paths with no coverage at
all. Wiring `emit` to `webContents.send`, exactly as production does, made the cancel test fail first
and then pass. A related find: a result only enters main's registry once its first page arrives, so a
runaway query — which by definition has produced nothing — could not be cancelled at all.
`QueryService.pendingRuns` closes that; cancelling an unregistered run measures **1.1ms**.

**Leaving a query result on screen for a minute used to crash the app.** `pg`'s `Pool` emits `'error'`
for _idle_ clients only, and the pool has always had a handler for that. A client handed out by
`acquire()` is not idle, so its errors went to the client's own `EventEmitter` — and an `'error'` event
with no listener is rethrown by Node as an uncaught exception, taking main down. The trigger is
completely ordinary: a result tab holds a `REPEATABLE READ` transaction open, and
`idle_in_transaction_session_timeout` is 60s. This was found only after the smoke harness was taught to
print a crash instead of hanging — before that, an unhandled rejection inside `app.whenReady().then(…)`
left Electron alive with nothing left to exit, and ten minutes of wall clock produced **no output at
all**. A harness whose whole job is to report was silent.

**A Vue reactive Proxy cannot cross the Electron bridge.** The export dialog keeps its options in a
`ref`, so what reached `exportStart` was a Proxy, and structured clone rejected it with "An object could
not be cloned". Because the bridge helper turns any rejection into a tagged `Result`, that surfaced as
`NOT_CONNECTED` — which reads as "main has no handler for this channel", a completely different bug
from the real one. **No unit test could have caught it**, because a stubbed bridge accepts anything; the
smoke harness driving the real dialog is what found it. The regression test now asserts
`isReactive(sent.options) === false` explicitly.

**The memory metric had to change before the number meant anything.** The first version of the live
export test asserted on _peak_ `heapUsed` and reported **435MB** — over PLAN's 150MB budget — for an
export that holds one 5,000-row batch. `heapUsed` without a collection is V8's _uncollected garbage_,
and a serialiser that allocates a string per row produces a great deal of it. Peak-during measures the
allocator's laziness; **retained-after-GC** measures whether anything was buffered, which is the actual
question. The assertion now forces a collection and reads **−0.5MB**. `npm run test:pg` supplies
`--expose-gc`, and the spec throws rather than silently falling back if it is missing — a bound asserted
against uncollected garbage is a measurement of nothing.

**Export has no path field, and that is the security design.** `ExportStartRequest` carries a result id
and options; the destination comes from `dialog.showSaveDialog` in main, so the only way bytes reach the
disk is through a picker the user just confirmed. Accepting a path from the renderer would let a
compromised one write anywhere the user's account can — a strictly worse posture than the one
`safeStorage` gives passwords. The harness asserts it end to end: it smuggles
`path: '/tmp/tabby-smuggled.csv'`, then checks both that the call is refused and that **no file appears
there**.

**Not yet verified by a human:** a real VoiceOver pass over the ARIA proxy grid **or** the
`role="tree"` (the tree carries `aria-level`/`aria-posinset`/`aria-setsize`, which is the documented
pattern for a virtualised list, but it has not been listened to), macOS full-screen restore, text
crispness when dragging to a different-DPI monitor, and — new in Phase 7 — whether the editor's
highlight layer and its textarea actually stay aligned on a real screen at a real font size. That last
one is asserted character-for-character in code and in Chromium, but "aligned" is ultimately a thing
eyes confirm. The bench and smoke harnesses drive the real DOM against a real database, which proves
the wiring and the frame budget, but not the feel.

New in Phase 8, and in the same category: whether the **light theme is actually pleasant**. The harness
proves `getComputedStyle(document.body).backgroundColor` goes from `rgb(3, 11, 22)` to
`rgb(255, 255, 255)` and back, which is a fact about the cascade and not about contrast ratios — no
WCAG audit has been run on either palette. No screen reader has been over the palette's
`combobox`/`listbox` wiring or the export dialog. And the native **save dialog has never been driven**:
no harness can click a sheet, so `save-dialog.ts` is the one Phase 8 file whose coverage stops at
typechecking.

**A known gap in the perf gate, found while measuring and deliberately left alone.** The grid bench
computes `sustainedFps` but does not fail on it: a run contaminated by a concurrent `npm run dev`
reported **15.6 fps** and still exited 0, because only `p95 < 10ms` and `frames >= 100` are checked.
The tree bench does gate on fps. Adding a floor to the grid bench changes a Phase 1 contract, so it is
flagged in `PLAN.md` rather than decided in passing.

## Getting started

```bash
nvm use
npm install
npm run dev        # Vite dev server + Electron with HMR
```

```bash
npm run verify     # deps:check + lint + typecheck + test + build
npm run i18n:check # every t() key exists in the catalogue; unused keys warn
npm run smoke      # boots real Electron, asserts the security model
npm run bench      # 600-frame scroll benchmarks for the grid and the tree —
                   # run on an otherwise idle machine
npm run pack:mac   # produce a .dmg (Phase 9)
```

The first Electron invocation downloads the ~300 MB binary on demand — see the note under
Prerequisites.

### Live database tests

`tests/integration/` covers the claims only a real server can settle: that read-only mode is actually
on, that a `NO SCROLL` cursor really cannot scan backward, that the first 1000 rows of a 10M-row table
really land inside 500ms, and that the detail pane reports a table the way the server describes it. It
**skips entirely** when no database is configured, so `npm test` stays green on a machine without one.

```bash
export TABBY_TEST_PG_HOST=localhost      # default
export TABBY_TEST_PG_PORT=5432           # default
export TABBY_TEST_PG_USER=postgres       # required
export TABBY_TEST_PG_PASSWORD=...        # required unless the server trusts you
export TABBY_TEST_PG_DATABASE=tabby-data-test

npm run pg:fixtures                     # idempotent, ~2s on a warm database:
                                        #  10M rows · 200k×17 · type/identity/identifier shapes
                                        #  detail_sample (every \d+ feature in one table)
                                        #  fixtures_many (2,000 relations, for the tree)
npm run test:pg
TABBY_REPORT_PERF=1 npm run test:pg     # also print the measured latencies
```

The same variables switch on the **live sections of the two Electron harnesses**, which are otherwise
database-free:

```bash
npm run smoke                            # +25 assertions: the columnar block survives Electron's
                                         #  serializer with its typed arrays intact (decoded by hand
                                         #  in the renderer), and so does the catalog payload —
                                         #  format_type modifiers, pg_get_indexdef text, the DDL
npm run bench                            # drives the real UI — connection picker, browse box, tree
                                         #  caret — then benches the grid AND scrolls the 2,000-row
                                         #  tree for 600 frames, reporting rows-in-tree vs rows-in-DOM
TABBY_BENCH_TABLE=fixtures.wide npm run bench   # benches a different live table
TABBY_BENCH_TREE_SCHEMA=fixtures_many npm run bench   # and a different tree schema
```

Credentials come from the environment only — nothing in this repository contains a password, and the
fixtures script creates no roles and grants nothing. CI runs the same suite against a `postgres:18`
service container.

The tests are read-only by construction, including the one that attempts an `INSERT` and asserts the
server refuses it. That one targets `fixtures.read_only_probe`, a throwaway table which exists so a
broken read-only guarantee would write there rather than into fixture data.

`fixtures.detail_sample` is the other kind of fixture: it exists so an assertion can be compared
against something a human can reproduce. Run `psql -c '\d+ fixtures.detail_sample'` and the
integration test's expected values are on screen — with the four documented divergences listed in
`PLAN.md` §Phase 6.

## Prerequisites

Node.js **24.x**, managed by nvm — already installed and verified:

|          |                                                                     |
| -------- | ------------------------------------------------------------------- |
| Node     | v24.21.0 (`~/.nvm`, Active LTS, matches Electron 44's bundled Node) |
| npm      | 11.19.0                                                             |
| Platform | arm64 / darwin                                                      |

```bash
nvm use default && node -v
```

Note: nvm loads from `~/.zshrc`, so `node` is absent from `PATH` in non-interactive shells (CI, Git
hooks, editor tasks). Those must source nvm explicitly.

### Two install behaviours worth knowing

- **npm 11 blocks dependency install scripts by default.** It warns about packages "not yet covered
  by `allowScripts`" (here: `esbuild`, `fsevents`, `electron-winstaller`). This project deliberately
  leaves them unapproved — esbuild resolves its platform binary through the `@esbuild/darwin-arm64`
  optional dependency instead, and everything builds and runs without them.
- **Electron 44 has no postinstall at all.** Its `package.json` ships no `scripts` field; the binary
  is fetched lazily by `node_modules/electron/index.js` on first `require('electron')`, verified
  against the bundled `checksums.json`. So a missing `node_modules/electron/dist` right after
  `npm ci` is expected, not a broken install — the first `npm run dev` or `npm run smoke` downloads
  it (~300 MB, then cached in `~/Library/Caches/electron`).
