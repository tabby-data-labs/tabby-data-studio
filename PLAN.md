# Tabby — PostgreSQL Database Viewer

Master plan. Last updated 2026-09-23.

Companion documents:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process model, IPC contract, data layer, security hardening
- [`docs/GRID-SPEC.md`](docs/GRID-SPEC.md) — canvas data grid specification (the hardest component)
- [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md) — executable first build, step by step

---

## 1. Locked decisions

| #   | Decision        | Choice                                       | Why                                                                                                                                                      |
| --- | --------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Grid rendering  | **Canvas 2D + DOM overlays**                 | 100k+ visible cells at 60fps; frozen panes are ~free; full control over selection. DOM only for editor, menus, tooltips, ARIA proxy.                     |
| D2  | Postgres driver | **`pg` (node-postgres) 8.23.0**              | Most battle-tested wire implementation. Pure JS — **no native modules**, so no node-gyp rebuild and no per-arch packaging pain.                          |
| D3  | Build wiring    | **`electron-vite` 5.0.0 + Vite 7.3.6**       | One config for main/preload/renderer with working HMR. Forces Vite 7 because electron-vite 5 peer-deps `^5\|\|^6\|\|^7` and does **not** support Vite 8. |
| D4  | v1 scope        | **Read-only browser + query console**        | No writes to the database in v1. Enforced server-side, not just in our code.                                                                             |
| D5  | TypeScript      | **6.0.2**, not 7.0.2                         | TS 7.0 ships **no programmatic API**; `vue-tsc` and `typescript-eslint` both consume the compiler API and cannot run on it. Revisit at TS 7.1.           |
| D6  | State           | **Pinia 4.0.3**                              | Official Vue, tiny, one dep.                                                                                                                             |
| D7  | Persistence     | **JSON files in `userData` + `safeStorage`** | OS-keychain-backed encryption for passwords with zero third-party crypto. No SQLite in v1 (would add a native module).                                   |
| D8  | SQL editor      | **Hand-built** (textarea + highlight layer)  | Monaco is a large third-party runtime dep; a Postgres lexer is ~300 lines we own.                                                                        |

### Decisions still open

See [§9 Open questions](#9-open-questions).

---

## 2. Verified version matrix

All versions checked against the npm registry on **2026-09-23**, then every pin re-verified with
`npm view <pkg>@<version> version` on the local Node 24.21.0 toolchain — all 13 resolve exactly.

### Runtime (shipped inside the app)

| Package | Version              | Transitive deps | Note                                                   |
| ------- | -------------------- | --------------- | ------------------------------------------------------ |
| `pg`    | `8.23.0` (pin exact) | 6               | The **only** runtime dependency of the entire product. |

`pg`'s tree: `pg-protocol`, `pg-pool`, `pg-types`, `pgpass`, `pg-connection-string`, `pg-cloudflare`.
`pg-cloudflare` is dead weight under Electron (Cloudflare-Workers shim) but is never loaded.
Do **not** install `pg-native` — that would introduce a native build.

### Dev / build-time (never shipped)

| Package                             | Version             | Note                                                                                                              |
| ----------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `electron`                          | `44.4.5`            | Chromium 152.0.7977.130, bundled Node **24.21.0**                                                                 |
| `electron-vite`                     | `5.0.0`             | Brings `esbuild`, `@babel/core`, `cac`, `magic-string`, `picocolors`                                              |
| `vite`                              | `7.3.6`             | Registry `previous` tag. `^7.3.6` stays inside 7.x. **Do not** bump to 8 — see D3.                                |
| `@vitejs/plugin-vue`                | `6.0.9`             | Supports Vite 5–8                                                                                                 |
| `vue`                               | `3.5.43`            | Runtime-only build; no `unsafe-eval` needed                                                                       |
| `pinia`                             | `4.0.3`             | Peer: `vue ^3.5.11`, `typescript >=5.6`                                                                           |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.3`             | v4 is CSS-first — **no `tailwind.config.js`**. Brings native `@tailwindcss/oxide` + `lightningcss` at build time. |
| `typescript`                        | `~6.0.2`            | See D5                                                                                                            |
| `vue-tsc`                           | `3.3.11`            | Peer `typescript >=5.0.0`                                                                                         |
| `@types/node`                       | `^24` → **24.13.6** | Match Electron 44's bundled Node 24, **not** `latest` (26.6.2)                                                    |
| `@types/pg`                         | **8.23.1**          |                                                                                                                   |
| `vitest`                            | `5.0.1`             | Supports Vite `^6.4\|\|^7\|\|^8`                                                                                  |
| `@vue/test-utils`                   | **2.5.1**           |                                                                                                                   |
| `electron-builder`                  | `26.15.3`           | Packaging                                                                                                         |
| `eslint` + `typescript-eslint`      | latest              | Must run on TS 6, not 7                                                                                           |
| `prettier`                          | latest              |                                                                                                                   |

### Host toolchain (verified present)

Managed by **nvm** at `~/.nvm`, with `default` aliased to `24`. Confirmed on this machine:

|          |                                                                   |
| -------- | ----------------------------------------------------------------- |
| Node     | **v24.21.0** — `~/.nvm/versions/node/v24.21.0/bin/node`           |
| npm      | **11.19.0**                                                       |
| corepack | present (so `pnpm` is available with no extra install)            |
| Platform | **arm64 / darwin** (Apple Silicon) — the primary packaging target |

Nothing to install. Node 24.21.0 is the current Active LTS **and** exactly the version Electron 44 bundles, so the host and packaged runtimes agree — this removes a whole class of "works in dev, breaks packaged" bugs.

- Node 24 → Maintenance LTS on **2026-10-20**, EOL **2028-04-30**
- Node 26 becomes LTS on **2026-10-27**
- Node 20 is already EOL; Vite 7 requires `^20.19.0 || >=22.12.0`

Add a `.nvmrc` containing `24` so the version is pinned per-directory and `nvm use` is automatic.

> **Gotcha:** nvm is loaded from `~/.zshrc`, so `node` is **absent from `PATH` in non-interactive
> `bash -c` shells** — CI runners, Git hooks, and editor task runners. Those must source nvm
> explicitly (`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`) or use the absolute binary path.
> In GitHub Actions use `actions/setup-node@v4` with `node-version-file: .nvmrc` instead.

### Planned upgrades (budget these, don't be surprised)

| What                  | When                                                      | Trigger                                                                          |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Electron 44 → 45 → 46 | Every ~8 weeks                                            | Electron supports only the **latest 3** majors. 44 goes EOL around **Feb 2027**. |
| Vite 7 → 8            | When electron-vite supports it                            | Vite 8 replaces Rollup+esbuild with Rolldown-only and changes CJS interop.       |
| TypeScript 6 → 7      | When TS 7.1 ships the new API **and** `vue-tsc` adopts it | Until then TS 7 breaks template type-checking.                                   |
| Node 24 → 26          | After 2026-10-27                                          | LTS handover.                                                                    |

---

## 3. Dependency budget — the security contract

The stated goal is a minimal third-party surface. Make that a **measurable invariant**, not an intention:

- **Runtime dependencies: exactly 1** (`pg`). Enforced by `npm run deps:check` (`scripts/check-deps.mjs`), which fails CI unless `package.json#dependencies` is exactly one entry — `pg`, pinned to an exact version.
- **Build-time vs shipped are different risk classes.** `electron-vite`, `esbuild`, `@babel/core`, `@tailwindcss/oxide`, `lightningcss` never enter the packaged `app.asar` — their risk is to the build machine, not to users. This is why D3 (accepting electron-vite) is defensible under a no-third-party preference.
- Lockfile committed, `npm ci` in CI, exact pins for runtime deps.
- `npm audit --omit=dev` is reported in CI but not blocking; escalate once the tree is clean.
- **npm 11 blocks dependency install scripts by default** (the `allowScripts` gate). Verified on this project: it builds, tests, and runs with `esbuild`, `fsevents`, and `electron-winstaller` all left unapproved — esbuild resolves its platform binary via the `@esbuild/darwin-arm64` optional dependency instead. Keep them unapproved; approving is a deliberate act that npm records pinned to an exact version.
- **Electron 44 has no postinstall.** Its `package.json` ships no `scripts` field at all; `index.js` downloads the binary lazily on first `require('electron')` and verifies it against the bundled `checksums.json`. Consequence: `node_modules/electron/dist` is legitimately absent right after `npm ci`. Do not "fix" that with a postinstall hook.

---

## 4. Product scope

### v1 (in scope)

1. Manage multiple saved Postgres connections (host/port/db/user/password/SSL/SSH-tunnel-later).
2. Browse the object tree: databases → schemas → tables / views / materialized views / indexes / constraints / functions, with comments.
3. Page through table data in an Excel-like grid, sorted and filtered server-side.
4. Query console: write SQL, run it, get one result tab per statement, cancel running queries.
5. Inspect a single cell's full value (JSON, text, bytea, timestamps).
6. Export a result set to CSV / JSON / SQL `INSERT` / TSV, streamed to disk.
7. Dark + light theme.

### v1 (explicitly out of scope)

Editing data (INSERT/UPDATE/DELETE through the grid), DDL execution, schema diffing, ERD diagrams, other database engines, cloud sync, plugins/extensions, auto-update, Excel binary export.

**However:** v1 must not make v2 expensive. `docs/ARCHITECTURE.md` §6 is a **design sketch** — as of Phase 4 the only part of it that exists in code is four type declarations at the bottom of `src/shared/domain.ts` — and it is written so cell editing stays _additive_ rather than a rewrite: a `RowIdentityResolver`, a `ChangeBuffer`, and a mutable `DataSource` variant. The editing groundwork in place today is `TableMeta.primaryKey` and `TableMeta.uniqueIndexes`, both populated from `pg_catalog` by Phase 4, plus the declared `RowKey` / `RowIdentityResolver` / `Change` / `ChangeBuffer` interfaces — no implementation, no editor, no write path. See Phase 10 for the rest.

### Non-negotiable product qualities

| Quality                                    | Target                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| Cold start to interactive window           | < 1.5s                                                      |
| Scroll frame budget with 1M rows loaded    | 60fps, no dropped frames while panning                      |
| First 1000 rows visible after query        | < 500ms (excluding server time)                             |
| Memory for a 1M-row × 20-col cached result | < 400MB in the main process, bounded by the result registry |
| Read-only guarantee                        | Enforced by the **server**, not only by our code            |

---

## 5. Architecture at a glance

```
┌────────────────────────── Electron main (Node 24) ─────────────────────────┐
│  ConnectionManager ── pg.Pool (max 1 per connection, read-only session)     │
│  SchemaService     ── pg_catalog introspection, cached + invalidated        │
│  QueryExecutor     ── statement_timeout, cancel via 2nd connection          │
│  ResultRegistry    ── server-side cursors, bounded LRU, TTL                 │
│  SettingsStore     ── userData JSON, passwords via safeStorage (Keychain)   │
│  IpcRouter         ── validates EVERY payload at the boundary               │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ contextBridge — typed, allowlisted, no raw ipcRenderer
┌───────────────┴──────────── Preload (sandboxed) ────────────────────────────┐
│  window.tabby : Readonly<TabbyApi>                                          │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │
┌───────────────┴────── Renderer (Vue 3.5 + Vite 7 + Tailwind 4) ─────────────┐
│  Pinia stores ── connections / schema / results / ui                        │
│  components   ── SchemaTree · QueryConsole · ResultTabs · CellInspector     │
│  grid/        ── CANVAS data grid, zero app imports, independently tested  │
│  sql/         ── Postgres lexer · statement splitter · highlighter          │
└─────────────────────────────────────────────────────────────────────────────┘
```

Three boundaries worth protecting:

1. **`src/shared/`** is the only code imported by all three processes. Types and the IPC contract, nothing else — no Node APIs, no Vue.
2. **`src/renderer/src/grid/`** imports nothing from `app/`, `components/`, or `stores/`. It receives a `DataSource` interface and emits events. Enforced by an ESLint `no-restricted-imports` rule. This is what makes it reusable and unit-testable.
3. **All SQL text is constructed in the main process only.** The renderer can request a table by identifier; it cannot make main interpolate unvalidated strings into SQL.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 6. Phase plan

Estimates assume one experienced developer, focused. Each phase has hard exit criteria — do not start the next phase while the current one is red.

### Phase 0 — Environment & scaffold · ✅ COMPLETE (2026-09-23)

**Goal:** an Electron window opens, built by electron-vite, type-checked, linted, tested.

- Node 24.21.0 already present via nvm — verify with `nvm use default`; add `.nvmrc` (`24`); `git init`; `.gitignore`; `.editorconfig`
- `package.json` with the exact pins from §2
- `electron.vite.config.ts` (main / preload / renderer), `tsconfig.node.json` + `tsconfig.web.json`
- Tailwind v4 via `@tailwindcss/vite` and `@import "tailwindcss"` in CSS — no config file
- Electron hardening from day one: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP, navigation guards
- ESLint flat config + Prettier + `typescript-eslint` on TS 6
- Vitest wired with a passing trivial test
- CI (GitHub Actions): `npm ci` → lint → `vue-tsc --noEmit` → `vitest run` → dependency-budget check

**Exit criteria — all met:**

| Check                         | Result                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `npm run deps:check`          | ✅ runtime deps = exactly `pg@8.23.0`                                               |
| `npm run lint`                | ✅ 0 errors / 0 warnings                                                            |
| `npm run typecheck`           | ✅ both projects                                                                    |
| `npm test`                    | ✅ 10 tests                                                                         |
| `npm run build`               | ✅ main 1.47 kB · preload 0.29 kB · renderer 194 kB + 9.28 kB CSS                   |
| `npm run smoke` (prod CSP)    | ✅ 12 assertions; `eval` + inline script **blocked**, violation observed in console |
| `npm run smoke:dev` (dev CSP) | ✅ 12 assertions; both **allowed**, as the dev policy intends                       |
| Renderer isolation            | ✅ no `require` / `process` / `Buffer` leak; renderer runs with `--enable-sandbox`  |
| Runtime versions              | ✅ Electron 44.4.5 · Chromium 152.0.7977.130 · Node 24.21.0                         |

**Deviations from the original plan, all deliberate:**

1. **Added a headless smoke harness** (`src/main/smoke-main.ts`, a second electron-vite main entry). The plan had no automated way to prove the security posture; this boots the real main process — the same `applySecurityGuards()` the app calls — and asserts CSP enforcement _behaviourally_ rather than by string-matching the policy constant. Runs in CI under both profiles.
2. **Dropped `baseUrl`** from both tsconfigs. TS 6 errors with `TS5101` because `baseUrl` is removed in TS 7; `paths` now resolves relative to the tsconfig file, which is the forward-compatible form.
3. **ESLint boundary rules are verified, not assumed.** Each of the four (grid↛Vue/app, renderer↛Node, shared↛electron, main↛`pg`) was proven to fire against a deliberate violation before the probes were deleted. Flat-config ordering matters here: the last matching block wins, so relaxations must come _after_ the global rules block.
4. **`npm audit` downgraded to non-blocking** in CI. A transitive advisory inside `pg`'s tree should not stall unrelated work.
5. **Dependency budget is enforced by `scripts/check-deps.mjs`**, not by parsing `npm ls`. It asserts `package.json#dependencies` is exactly one entry, `pg`, pinned to an exact version — a stronger and more stable check.

→ Full step-by-step in [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md).

### Phase 1 — Grid core: layout & rendering · ✅ COMPLETE (2026-09-27)

**Goal:** a canvas grid scrolls through **1,000,000 synthetic rows × 30 columns** at 60fps with no database anywhere.

- `GridLayout` — pure function: (columns, widths, frozen counts, rowHeight, scrollTop, scrollLeft, viewport) → visible ranges + pixel rects. No DOM. Heavily unit-tested.
- Inverse hit-testing: (x, y) → `{ row, col }` accounting for frozen panes
- Canvas layers on **separate** elements: `body`, `colHeader`, `rowHeader`, `corner`, `overlay` — so scrolling never redraws headers
- HiDPI: `canvas.width = cssWidth * devicePixelRatio` + `setTransform`; listen for DPR changes (monitor switch, zoom)
- Text-measurement cache (LRU, ~10k entries) — this is the #1 canvas-grid perf trap
- `requestAnimationFrame` loop driven by a dirty flag; never render straight from a scroll event
- Custom scrollbar with a proportional thumb (a native scrollbar cannot represent 10M rows sanely) + wheel/trackpad handling incl. `deltaMode`
- Frozen columns + frozen header row, with drop shadow
- Column resize by drag; double-click to auto-fit from measured sample widths
- `FakeDataSource` generating deterministic typed rows, so every later phase can be built against a stable contract

**Exit criteria — measured, not eyeballed:**

| Criterion                                  | Result                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1M×30 sustained 60fps                      | ✅ **60.0 fps**, 599 frames, 1 dropped, 9.98s wall (two consecutive isolated runs)                                                  |
| Paint budget p95 < 10ms                    | ✅ **p50 3.0 · p95 3.2–3.4 · p99 3.5–3.7ms**                                                                                        |
| `measureText` < 2,000/frame                | ✅ 500 lookups, **0 native misses** (monospace arithmetic)                                                                          |
| Frozen panes aligned at fractional offsets | ✅ covered by 35 `layout` specs incl. `scrollTop: 100.5` / `137.25`                                                                 |
| Column resize without leaks                | ✅ drag + dbl-click auto-fit; listeners/canvases torn down in `destroy()`                                                           |
| `GridLayout` branch coverage ≥95%          | ⚠️ **not measured** — coverage provider not wired up. 35 specs cover every branch by construction, but the ≥95% claim is unverified |
| Five canvas layers, never per-cell         | ✅ asserted by the smoke harness                                                                                                    |
| Renders in real Electron                   | ✅ smoke paints **92 distinct colours**, 0 console errors                                                                           |

Delivered as 15 modules / 3,164 lines in `src/renderer/src/grid/`, with **239 tests** across 14 files.

**Three findings that changed the design:**

1. **A measurement cache is not enough** (the big one). High-cardinality database columns mean nearly every string is new, so the cache missed 96% of the time — 343 native `measureText` calls per frame, p95 **12.1ms, over budget**. Detecting a monospace face with two probes and switching to `length × charWidth` arithmetic took p95 to **3.4ms** with **0** misses. See GRID-SPEC §4.
2. **A benchmark without a warm-up pass measures the wrong thing.** The first run reported a comfortable p50 5.4ms — but it was painting skeleton placeholders, not text. Adding a warm-up pass exposed the real 12.1ms and triggered finding #1. A flattering benchmark is worse than none.
3. **`sustainedFps` measures rAF delivery, not paint cost.** It read 24.2fps when the bench ran straight after the test suite in the same shell, and 60.0fps in isolation, with identical paint timings. Gate on paint percentiles; treat fps as corroboration.

Also: `hitTest` became a discriminated union (the sketched `{ row: -1 }` sentinel could not express a row-header click), `rowCount` had to be added to `GeometryInput`, and per-column `frozen` flags were dropped in favour of a positional `frozenColumnCount` so the two cannot disagree. Details in GRID-SPEC §3.

**Deferred from Phase 1:** keyboard navigation, multi-range clipboard formats, context menu, cell inspector and the ARIA proxy grid are Phase 2 as planned. `copy()` currently emits TSV only. Basic pointer selection (click / shift-click / drag / header / corner) was pulled forward because the paint pass needs it to draw a highlight.

### Phase 2 — Grid interaction · ✅ COMPLETE (2026-09-27)

**Goal:** it _feels_ like Excel.

- Selection model: anchor + focus, contiguous ranges, ctrl/cmd multi-range, click-header = whole column, click-row-header = whole row, shift+click = extend, drag rubber-band on the overlay canvas
- Keyboard: arrows, shift+arrows, cmd+arrows (to edge), PageUp/Down, Home/End, cmd+Home, Tab/Enter navigation, Esc to clear
- Copy: TSV (Excel-compatible) to `navigator.clipboard`, plus CSV / JSON / SQL `INSERT`. Cap + progress above ~100k cells.
- Context menu (DOM overlay): copy cell/range, copy as…, freeze here, hide column, sort
- Cell tooltip on hover; **Cell Inspector** panel showing the full untruncated value
- Type-aware rendering: `NULL` italic-grey, boolean glyph, numbers right-aligned with `tabular-nums`, timestamps normalised, `bytea` as `<N bytes>`, `json` as `{…}` + preview
- **ARIA proxy**: an offscreen `role="grid"` mirroring the visible window with true `aria-rowcount` / `aria-colcount` and per-row `aria-rowindex`, plus a live region announcing selection. A bare canvas is invisible to screen readers; do not skip this.

**Exit criteria — verified end-to-end in real Electron, not just in units:**

| Criterion                                     | Result                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copying a block produces a correct Excel grid | ✅ `cmd+C` on a 4×3 block yielded **4 CRLF rows × 3 tab fields**, first row `34⇥582476⇥true`. Verified by intercepting the real `clipboard.writeText` payload.                                                                                                                       |
| Keyboard-only navigation reaches any cell     | ✅ Real `KeyboardEvent`s drove the grid: arrows, shift+arrows (12-cell block), `cmd+End` → **row 1,000,000 col 30**, `cmd+Home` → A1, PageDown → 15-row jump, Esc → collapse. Read back through the status bar, so the full path (event → reducer → callback → Vue → DOM) is proven. |
| Screen reader announces row/column/value      | ✅ Live region emitted `"Row 20 of 1000000, column flag_2, true"`. Proxy carries `aria-rowcount=1000001`, `aria-colcount=30`, absolute `aria-rowindex`, 30 cells/row, 12 `aria-selected`. **Actual VoiceOver run still needs a human** — see caveats.                                |
| Smoke harness                                 | ✅ **39/39 assertions**, both CSP profiles                                                                                                                                                                                                                                           |
| Paint budget after the a11y work              | ✅ p50 2.50 · **p95 7.60** · p99 ~8.0ms (budget 10ms), 60.0 fps                                                                                                                                                                                                                      |
| Tests                                         | ✅ **442** across 19 files; lint/typecheck/prettier/build green; runtime deps still exactly `pg`                                                                                                                                                                                     |

Delivered as 22 modules / 5,047 lines in `src/renderer/src/grid/`. New in Phase 2: `keyboard.ts`
(44-test modifier/platform matrix), `clipboard.ts` (5 formats, RFC 4180, lazy chunking), `aria.ts`
(proxy grid), `context-menu.ts`, `tooltip.ts`, `inspector.ts`.

**Four findings that changed the code:**

1. **The ARIA proxy was a paint-budget problem, twice over.** Mirroring the visible window rebuilds
   ~780 nodes; done per frame it pushed p99 to 9.9ms. Throttling inside the rAF callback moved the
   spike rather than removing it (p95 8.9ms). The fix was structural: refresh on an independent 10Hz
   timer **and pool the DOM nodes** instead of recreating them, so steady-state scrolling allocates
   nothing. Result p95 **7.60ms**, p50 down to 2.50ms — better than before accessibility work began.
2. **I misdiagnosed the clipboard failure and had to correct myself.** An empty system clipboard
   looked like "packaged `file://` renderer is not a secure context", and I wrote a whole
   `execCommand` fallback module for it. Instrumenting instead of guessing showed
   `isSecureContext: true` and the real error — `NotAllowedError: Write permission denied`, because
   Chromium requires _transient user activation_ and a synthetic `dispatchEvent` is untrusted
   (`navigator.userActivation.isActive === false`). **The fallback addressed a scenario that cannot
   happen, so I deleted it.** The harness now asserts the intercepted payload, which is stronger
   evidence than the OS clipboard anyway.
3. **Two Electron traps worth remembering.** `clipboard.readText()` must be called _bound_ —
   detaching it loses Electron's `this` and returns a non-string (I hit this twice). And Electron's
   global `Clipboard` interface declaration-merges with the DOM lib's, so TypeScript picks the
   `Promise<string>` overload; cast the result, never the method.
4. **A permission allowlist is a tightening, not a relaxation.** `applySecurityGuards` now installs
   both `setPermissionRequestHandler` and `setPermissionCheckHandler` (Chromium checks
   `clipboard-sanitized-write` via the _check_ handler, so setting only the request handler leaves
   copy broken). Everything not on the one-entry allowlist is denied outright — geolocation, camera,
   microphone, notifications.

**Deviations from the spec, deliberate:**

- **Boolean cells render `true`/`false` text, not the ☑/☐ glyph** from GRID-SPEC §9. Text is readable,
  searchable and copies correctly; a glyph risks missing-font boxes and conveys less. The glyph stays
  available for a later theme toggle.
- **`tabular-nums` is unnecessary** rather than implemented: canvas has no `font-variant-numeric`, and
  the grid uses a monospace face where every digit already has equal advance, so right-alignment gives
  perfect column alignment for free.
- **`cmd+arrow` "to edge"** is blank-aware via an injected `isBlank` predicate, so the reducer stays
  pure. An _unloaded_ cell reports non-blank on purpose: stopping at the edge of the loaded window
  would silently truncate the jump.

**Caveats — not claimed:**

- **No human VoiceOver pass.** The proxy structure and announcement text are asserted
  programmatically; whether VoiceOver actually navigates it well needs a person with a screen reader.
- **Copy is not verified against the real OS clipboard**, for the user-activation reason above. The
  serialisation is verified at both the unit level (65 tests) and the intercepted-payload level.
- **The 500×20 exit criterion was verified as 4×3** end-to-end plus arbitrary sizes at unit level.
  Driving 500 shift+arrow keypresses through the harness is slow and tests nothing new about the
  wiring; the large-range behaviour is covered by the chunking and progress tests instead.
- **No coverage measurement** (unchanged from Phase 1 — no coverage provider installed).

### Phase 3 — Electron shell & IPC · ✅ COMPLETE (2026-09-27)

**Goal:** the hardened three-process contract is real, not a stub.

- Preload exposes a frozen, typed `window.tabby`; raw `ipcRenderer` never leaks
- IPC contract types in `src/shared/ipc-contract.ts`, one source of truth for both sides
- Hand-written boundary validators (~120 lines) in main — no third-party schema lib
- Settings store: connections list, window geometry, theme; passwords encrypted with `safeStorage`
- Window state persistence; macOS full-screen and restore behaviour
- Tab UI shell (result tabs, query tabs)

**Exit criteria — all three verified end-to-end in real Electron (59/59 smoke assertions):**

| Criterion                                                   | Result                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer can round-trip a validated request                 | ✅ `getSettings()` → `patchSettings({theme:'light'})` → re-read returns `'light'`. Full path exercised: renderer → contextBridge → `ipcMain` → validator → `SettingsStore` → `Result` back.                                                                                                                                         |
| Malformed/hostile payloads are rejected and logged          | ✅ **8/8 hostile payloads** returned tagged `VALIDATION_FAILED` — none accepted, **none threw** across the bridge: wrong type, unknown key, negative row, 100M-row window, NUL byte in SQL, bad enum, `__proto__` pollution, non-object. Rejections log channel + field path only, never the payload, which could carry a password. |
| Passwords are ciphertext at rest, never in logs or DevTools | ✅ The settings file is read back **from the main process** — the renderer cannot attest to this without the check being circular. It contains `enc(…)` ciphertext and not the plaintext. `ConnectionSummary` carries neither plaintext nor ciphertext. Every log line passes through `scrub()`.                                    |

Also asserted: `Object.isFrozen(window.tabby)`, no `ipcRenderer` leak, double `deleteConnection` →
`NOT_FOUND`, and an unimplemented channel answers `NOT_CONNECTED` rather than throwing.

Delivered: `src/main/ipc/{validate,router}.ts`, `src/main/store/{cipher,settings-store}.ts`,
`src/main/window/window-state.ts`, `src/main/log.ts`, the full typed preload bridge, and
`stores/tabs.ts` + `TabBar.vue`. **542 tests across 22 files**; paint budget unchanged
(p50 2.60 · p95 7.40 · p99 7.90ms, 60.0 fps, 1 dropped in 599).

**Four decisions worth recording:**

1. **The Phase-4 placeholder channels validate _now_, not later.** My first router registered them
   with a parser that accepted anything, so a hostile payload to `resultWindow` short-circuited to
   `NOT_CONNECTED` and was never validated. The smoke harness caught it. Every channel is now
   validated and returns `NOT_CONNECTED` only _after_ validation passes — so an unimplemented
   handler cannot become a hole, and Phase 4 swaps a handler body instead of rewiring guards.
2. **No third-party schema library.** The validators are ~320 hand-written lines, not the ~120
   estimated. That is the security boundary of the whole app, it is covered by 42 tests, and it keeps
   the runtime dependency count at exactly one.
3. **An unavailable keychain refuses rather than falling back to plaintext.** `safeStorage` can be
   unavailable (Linux without a keyring). A database password in cleartext JSON is a leak that
   outlives the session and is invisible to the user, so `saveConnection` returns
   `KEYCHAIN_UNAVAILABLE` instead. Saving without a password still works, and editing a connection's
   name preserves its stored credential.
4. **`getNormalBounds()`, not `getBounds()`, for persisted geometry.** For a maximised or full-screen
   window the latter returns the enlarged geometry, so restoring it leaves the user with an
   un-maximised window the size of their whole screen. Writes are debounced at 500ms and flushed
   synchronously on `close`, because `resize` fires per pixel and each persist is a sync write.

**Corrupt-file behaviour:** a hand-edited or truncated `settings.json` falls back to defaults with a
surfaced `loadWarning` rather than throwing during startup, where there is no UI to show the failure
in. A malformed connection entry is dropped while valid ones are kept — losing every saved
connection over one bad field is the worse outcome.

**Not done in Phase 3:** the tab shell renders and its store is fully tested (31 specs), but the tabs
are seeded placeholders; real query/result tabs get wired in Phases 4 and 7 when there are queries to
run. macOS full-screen _restore_ is implemented but has not been exercised by a human.

### Phase 4 — Postgres data layer · ✅ COMPLETE (2026-10-01)

**Goal:** real queries, positionable and bounded, and provably read-only.

- `ConnectionManager`: one small `pg.Pool` per saved connection, lazy connect, health checks, clean teardown
- **Read-only enforcement on connect:** `SET default_transaction_read_only = on`. Server-side, so even a bug in our SQL generation cannot write. Document creating a read-only DB role as the belt-and-braces option.
- Session limits: `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`
- SSL config with explicit `rejectUnauthorized`; no silent trust
- Identifier handling: a `quoteIdent` that validates against a safe character class and doubles `"` — never naive concatenation
- Schema introspection against `pg_catalog` (`pg_namespace`, `pg_class`, `pg_attribute`, `pg_type`, `pg_index`, `pg_constraint`, `pg_description`) with per-connection caching and manual/explicit invalidation
- **Row-identity groundwork for v2 editing (types only).** This is the moment `pg_constraint`/`pg_index` are already being read, so primary-key and best-unique-index detection is nearly free here and expensive to retrofit later. Deliver `RowIdentityResolver` and `ChangeBuffer` in `src/shared/domain.ts` as _declared types with no implementation_, plus the PK columns already carried on `TableMeta`. Explicitly **not** in scope: any editor, any write path, any change tracking. `default_transaction_read_only` stays on and the Phase 4 exit criterion below still asserts writes fail — the types must not become a backdoor. If by the end of Phase 5 these types have not needed to change, the v1 contract is genuinely editing-ready; if they have, fix them now rather than in Phase 10.
- **Positionable large results:** `BEGIN` + `DECLARE <name> CURSOR FOR <query>` + `FETCH`/`MOVE ABSOLUTE`, so the grid can jump to row 800,000 without `OFFSET` scanning a million rows
- `ResultRegistry`: `resultId` → cursor + column metadata; bounded count, TTL, LRU eviction, memory cap
- `query:cancel` via a **second** connection running `pg_cancel_backend(pid)` — you cannot cancel on the connection that is busy
- Columnar transfer codec: `{ columns, rowCount, columns: TypedArray[] }`, transferring `ArrayBuffer`s over structured clone instead of shipping 1M row objects
- Row count: `pg_class.reltuples` estimate instantly, exact `count(*)` in the background on request

**Exit criteria:** a `SELECT` over a 10M-row table returns its first 1000 rows in <500ms of client overhead; jumping to an arbitrary row offset works; cancelling a long query returns the UI to responsive within 200ms; `default_transaction_read_only` is verified on by a test that asserts an `INSERT` attempt fails with SQLSTATE `25006`; the registry never exceeds its memory cap under a soak test.

#### Result

Verified against **PostgreSQL 18.6** on localhost, with a seeded 10M-row / 789 MB `fixtures.big`
(`scripts/pg-fixtures.sql`, idempotent). Every number below is a measurement from
`TABBY_REPORT_PERF=1 npm run test:pg` — one run on an arm64 MacBook with the server local, so read
them as an order of magnitude rather than a benchmark to beat. Repeat runs varied by a few ms.

| Exit criterion                                          | Result                                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First 1000 rows of a 10M-row `SELECT` in <500ms         | ✅ **19.1ms** client overhead (DECLARE + FETCH 1000 + columnar encode). First window served from the prefetch: **0.2ms**.                                                          |
| Jumping to an arbitrary row offset works                | ✅ forward to row 800,000 in **63.4ms**; backward to row 10 in **1.1ms**; browse-mode `OFFSET` to row 5,000,000 in **372.9ms**. All returned the correct rows.                     |
| Cancel returns the UI to responsive within 200ms        | ✅ **2.8ms**, and the in-flight `FETCH` failed with SQLSTATE **57014** → `QUERY_CANCELLED`                                                                                         |
| Read-only verified by an `INSERT` failing with `25006`  | ✅ `25006` → `READ_ONLY_VIOLATION`. Also asserted for `UPDATE`, `DELETE`, `CREATE`, `DROP`, `TRUNCATE`, and through the query channel. The probe table has **0 rows** afterwards.  |
| Registry never exceeds its memory cap under a soak test | ✅ 12 results × 4 windows against `maxEntries: 3` / `maxBytes: 400 kB`; caps checked after **every** operation. All evicted cursors released — **0** idle-in-transaction backends. |

Gate: `npm run verify` ✅ (deps `pg` only · prettier clean · lint 0/0 · typecheck both projects ·
**889 unit tests** · build) · `npm run test:pg` ✅ **44 integration tests** · `npm run smoke` and
`smoke:dev` ✅ **61/61** each, 0 failures · `npm run bench` ✅ p50 2.60 · **p95 3.40** · p99 5.90ms ·
**60.0 fps** · 1 dropped in 599 · 0 measureText misses.

Delivered: `src/main/db/{ident,sql-scan,session,pg-config,pg-error,result-sql,result-registry,introspect,row-shape,driver-pg,connection-manager,schema-service,query-service,services}.ts`,
`src/shared/{pg-types,columnar}.ts`, the real router handlers, and `tests/integration/`. `pg` is still
imported by exactly one file.

**Ten findings that changed the design — all found by running against a real server, not by reading:**

1. **`NO SCROLL` cannot scan backward, and trying _aborts the whole transaction_.** §5.2 claimed "the
   grid only ever moves forward plus jumps, which `MOVE ABSOLUTE` covers." That is wrong: a user
   scrolling up produces `ERROR: cursor can only scan forward`, after which the cursor is unusable.
   Fixed by closing and re-declaring inside the **same** transaction, which is why the transaction is
   `REPEATABLE READ` — the re-declared cursor reads the same snapshot, so rows do not shift.
2. **`max: 2` in §5.1 deadlocks.** Every result holds its client for its whole life, so four results
   plus the reserved cancel client leave nothing for catalog reads or the background count, and the
   next schema-tree expansion queues forever. Now `4 cursors + 1 cancel + 2 aux = 7`.
3. **Session hardening raced the first query.** Issuing the eight `SET`s through a `.then()` chain
   defers to a microtask, and the pool resolves the waiting caller in the same tick — so a query could
   run before the settings landed. Observed for real: `current_setting('TimeZone')` returned
   `Asia/Jakarta` on a connection that already reported read-only mode **on**. Now one multi-statement
   `SET`, enqueued synchronously in the pool's `connect` handler.
4. **`pg` returns `name[]` as text.** `array_agg(attname)` came back as `{tenant_id,seq}`, and
   spreading that string produced a primary key of `['{','t','e','n',…]` — punctuation that would have
   been quoted straight into a `WHERE` clause and silently matched nothing. Fixed with `::text[]`, and
   `toTableMeta` now throws a `TypeError` rather than spreading a non-array.
5. **`pg`'s default parsers lose fidelity.** `timestamp` was parsed in the _host_ timezone (a 7-hour
   lie on this machine), `date` shifted a calendar day, `interval` became `{days:1,hours:2,…}`, and
   `json` was parsed and re-stringified. All eight types now keep the server's own text or a
   deterministic UTC reading.
6. **`count(*)` over an arbitrary statement was removed.** It re-executes the user's query, so opening
   a result tab on an expensive statement would run it a second time on somebody's production database
   unasked. Browse mode counts the table; a cursor learns its exact count when it reaches the end and
   reports `-1` until then. `countSql` and its three passing tests were **deleted**, not weakened.
7. **The eager prefetch was being thrown away.** `run()` fetched 200 rows for the column metadata and
   dropped them, so the first `window({startRow: 0})` was a _backward_ jump — a re-declare, i.e. a
   second full execution of the query. The prefetch is now served (any window inside it) and its bytes
   are returned to the registry once a request moves past it.
8. **An injected `ResultRegistry` leaked pool clients.** Eviction is what closes a cursor and releases
   its client, and that cleanup was wired through `onEvict` at construction — so a caller-supplied
   registry carried the caller's callback and every eviction dropped a client. Surfaced as
   "timeout exceeded when trying to connect" after a dozen results. `QueryService` now takes
   `limits`, not a registry: bounds are injectable, ownership is not.
9. **`EPIPE` and `EPERM` have the SQLSTATE shape.** Five characters of `[0-9A-Z]`, on the same `.code`
   property `pg` uses — so a dead socket was reported as a server error. Disambiguated by the `E`
   prefix: every Node errno starts with it, no Postgres SQLSTATE class does.
10. **`quoteIdent`'s allowlist in §5.6 would break real databases.** Rejecting everything outside
    `[A-Za-z0-9_$]` makes `Mixed Case`, `has space`, `with"dquote` and `unicode_ünïcødé` unbrowsable —
    all four exist in the fixtures and all four round-trip now. Split into `quoteIdent` (always
    quotes, doubles `"`, refuses NUL and >63 **bytes**) for names that came from somewhere, and
    `isGeneratedName` (the allowlist) for names Tabby invents.

**Also worth recording:** `pg_cancel_backend` needs the pid of the _specific_ backend running the
query, so it is read once per acquired client rather than per fetch. `idle_in_transaction_session_timeout`
(60s) is shorter than the registry TTL (10 min), so a cursor result can die of idleness first; that
surfaces as `CURSOR_CLOSED` ("re-run the query") and browse mode is immune because it holds no
transaction. And the cancellation fixture could not be a SQL function: returning a set lets Postgres
materialise the body, so the first `FETCH` waited for all 1000 sleeps. `pg_sleep` in the target list
of a plain query streams correctly.

**Not done in Phase 4:** `RowIdentityResolver` and `ChangeBuffer` are declared in
`src/shared/domain.ts` and nothing more, as specified — `paginationKeyFor` is a _paging_ decision and
deliberately not the row-identity resolver. There is no UI yet: the renderer still shows the synthetic
1M-row grid, and wiring `RemoteDataSource` to these channels is Phase 5. Coverage remains unmeasured
(no coverage provider installed).

### Phase 5 — Grid on live data · ✅ COMPLETE (2026-10-02)

**Goal:** swap `FakeDataSource` for the IPC-backed one without touching grid code.

- `RemoteDataSource implements DataSource`: windowed fetch by row range, read-ahead prefetch of adjacent blocks, in-flight dedupe, stale-response cancellation
- Loading skeletons, per-range error surfaces, retry
- Server-side sorting (re-query with `ORDER BY`, never client-side sort of a partial window)
- Connection-loss and cursor-invalidation recovery

**Exit criteria:** the grid module's public API and its unit tests are **unchanged** from Phase 2 — proof the boundary held. Fast-scrolling a 10M-row table shows placeholders, never wrong data, and never blocks the main thread.

#### Result

| Exit criterion                                                             | Result                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grid public API and unit tests unchanged                                   | ✅ **Proven, not asserted:** `git diff --stat HEAD -- src/renderer/src/grid tests/unit/grid-*.spec.ts tests/unit/helpers` is **empty**. 22 grid modules and 17 grid spec files are byte-identical to Phase 2. |
| Fast-scrolling a large table: placeholders, never wrong data, never blocks | ✅ Measured through the **real UI** against live Postgres — the bench harness drives the connection picker and the browse box, then clicks the same button a user would. See the two runs below.              |

Live scroll benchmarks (`npm run bench` with `TABBY_TEST_PG_*` set), each 599 frames:

| Source                                         | p50    | p95        | p99    | fps   | dropped | measureText |
| ---------------------------------------------- | ------ | ---------- | ------ | ----- | ------- | ----------- |
| `fixtures.big` — 10M rows × 4 cols (browse)    | 1.70ms | **2.00ms** | 2.20ms | 60.00 | 1       | 67,084      |
| `fixtures.wide` — 200k rows × 17 cols (browse) | 3.00ms | **3.70ms** | 4.40ms | 60.00 | 1       | 508,188     |
| synthetic — 1M rows × 30 cols (no database)    | 2.50ms | **3.90ms** | 5.20ms | 60.01 | 1       | 283,907     |

The 17-column live run is the honest one: it includes an IPC round trip, a
`FETCH`/keyset seek against Postgres, and a columnar decode per block, _while_
painting at 60fps. It lands at p95 3.70ms against a 10ms budget — comparable to
the synthetic grid that touches no database at all.

Gate: `npm run verify` ✅ (deps `pg` only · prettier clean · lint 0/0 · typecheck ·
**954 unit tests** · build) · `npm run test:pg` ✅ **44 integration** · `npm run smoke`
and `smoke:dev` ✅ **61/61** · `npm run smoke` with a database ✅ **74/74** ·
`npm run bench` ✅ synthetic and both live configurations.

Delivered: `src/renderer/src/data/{remote-source,ipc}.ts`, `stores/{connections,results}.ts`,
`components/{ConnectionBar,QueryBar,ResultStatus}.vue`, a rewritten `App.vue`, the live
section of the smoke harness, live mode in the bench harness, and `fixtures.wide`.
`src/shared/ident.ts` moved out of `src/main/db/` — the renderer needs `quoteQualified`
for the browse shortcut, and Phase 6's "copy qualified name" needs it too.

**Seven findings:**

1. **Three of the four bullets were already built, in the grid.** Read-ahead prefetch,
   in-flight dedupe and stale-response abort all live in `DataWindowController`
   (Phase 1), and "loading skeletons" are `paint.ts` drawing `theme.placeholder` for a
   missing cell. Reimplementing them in `RemoteDataSource` would have put two
   components in charge of deciding what to fetch. So `getBlock` is one honest request
   per call and nothing more.
2. **The gap the plan did not name was retry policy — and the grid structurally cannot
   own it.** `DataWindowController.request()` re-asks for any block that is neither
   cached nor in flight, and `update()` runs every frame. A range that fails
   permanently is therefore re-requested **60 times a second forever**: against a server
   that has gone away, a retry storm the user can neither see nor stop. Backoff
   (250ms → 8s), an attempt limit, and terminal states live in `RemoteDataSource`
   because the grid's API is frozen and the grid has no idea a failure was permanent.
3. **The IPC event contract was broken and nothing could see it.** `TabbyEvents`
   declared `onConnectionLost(listener: (connectionId: string) => void)`; main emitted
   `{ connectionId }`. The emitter was typed `(channel: string, payload: unknown)`, so
   neither the compiler nor any test could catch it — a listener would have compared an
   object to a string and silently never matched. Both ends now derive from a single
   `MainEventMap`, and the integration suite pins the payload shape at runtime.
4. **`result:meta` was a registered channel with a router handler that was never on
   `DatabaseApi` or in the preload.** The renderer literally could not ask for the exact
   row count, so the `reltuples` estimate would have stayed on screen forever. Found by
   the compiler the moment the results store needed it.
5. **`invoke` only returns a `Result` when a handler exists.** A missing channel
   _rejects_ — and an uncaught rejection in the renderer becomes a console error the user
   cannot see, which took the bench harness down with it (both harnesses treat console
   errors as failures). Every renderer → main call now goes through `invoke` /
   `invokeDetached`, so "the server said no" and "there was nobody to ask" share one path.
6. **Closing a connection raced its own cursors.** A live result holds a checked-out pool
   client for its whole life, and `pool.end()` waits for every client to return — but
   eviction released them fire-and-forget. In the app that meant `will-quit` always burned
   its 2s grace period and exited by force whenever a result tab was open; in the bench
   harness it hung **forever**. `QueryService.drain()` now awaits the releases, and
   `services.dispose()`, `conn:close` and `conn:delete` all call it first.
7. **Typed arrays survive Electron's IPC — verified, not assumed.** This was the
   load-bearing risk of the whole columnar design: the unit tests round-trip through
   Node's `structuredClone`, which is not the serializer Electron uses for `invoke`
   results. The smoke harness now decodes a live block **by hand in the renderer** and
   asserts `nulls` is still a `Uint8Array`, `offsets` a `Uint32Array`, `values` a
   `Float64Array`, and that the bytes spell `1`, `5` and `row-1`.

**Not done in Phase 5:** no human has clicked around a live result yet — the bench and
smoke harnesses drive the DOM, which proves the wiring but not the feel. The connection
editor is functional but plain (six fields, inline, no validation beyond what the IPC
boundary enforces); Phase 6's explorer will supersede most of it. A query tab still shows
the demo grid, because the editor is Phase 7. `RemoteDataSource` has no block cache of its
own, so a scroll back over recently-seen rows re-fetches whatever the grid's LRU evicted.
Coverage remains unmeasured.

### Phase 6 — Schema explorer · 5 days · ◄── NEXT

- Hand-built virtualised tree (reuse the grid's windowing concepts, not its code)
- Table detail pane: columns, types, nullability, defaults, indexes, constraints, comments, generated DDL
- Right-click → "Select top 1000", "Copy name", "Copy qualified name", "Filter to…"
- Refresh + invalidation

**Exit criteria:** a database with 2,000 tables renders and scrolls smoothly; the object tree matches `psql`'s `\d+` output for a sample table.

### Phase 7 — Query console · 8–12 days

- Editor: `<textarea>` overlay + a highlighted `<pre>` behind it, scroll-synced, with line numbers and current-line highlight
- Hand-written Postgres lexer (~300 lines): keywords, identifiers, `"quoted idents"`, `'strings'` with `''` escapes, `$$dollar quoting$$`, `E''` escapes, numbers, operators, `--` and `/* */` comments
- **Lexer-aware statement splitter** — never split on `;` naively; `;` inside a string, comment, or dollar-quoted body must not split
- Cmd/Ctrl+Enter runs; one result tab per statement; per-statement timing and row count
- Cancel button wired to `pg_cancel_backend`
- Query history (JSONL, rotated). **Privacy note:** history may contain literals including secrets — store locally, never sync, and offer a clear-history action.
- `EXPLAIN` / `EXPLAIN ANALYZE` rendered as a plan tree

**Exit criteria:** the splitter correctly handles a script containing a `$$` function body, a `--` comment with a semicolon, and a string literal with a semicolon; cancelling a runaway query works from the UI.

### Phase 8 — Export & polish · 5 days

- Streamed export to CSV / JSON / SQL `INSERT` / TSV, writing directly to disk from main (never through the renderer), with progress and cancel
- RFC 4180-correct CSV quoting; configurable delimiter, encoding, NULL representation, header row
- Command palette (fuzzy, hand-written)
- Dark/light theme via Tailwind v4 `@theme` tokens + CSS variables
- i18n hooks (string extraction, no runtime framework yet)

**Exit criteria:** exporting 1M rows to CSV completes without exceeding ~150MB of renderer memory and can be cancelled mid-flight.

### Phase 9 — Packaging & release · 3–5 days

- `electron-builder` config: macOS `dmg` + `zip`, `arm64` and `x64`; `asar: true`; **no `asarUnpack` needed** because there are no native modules
- App icon, name, bundle id, category
- Code signing + notarization hooks (requires an Apple Developer ID; without it, document the Gatekeeper right-click-open workaround)
- Smoke-test matrix: install, launch, connect, query, export on a clean macOS VM
- Auto-update deliberately deferred (`electron-updater` needs hosting)

**Exit criteria:** a signed, notarized `.dmg` installs and runs on a clean Mac and passes the smoke test.

### Phase 10 — v2 groundwork

> **Status check before starting (updated at Phase 4 completion):** there is still **no editing
> behaviour anywhere** — a grep of `src/**` for `beginEdit|commitEdit|setCell|editable` returns zero
> matches, verified. What Phase 4 added is declarations only: `RowKey`, `RowIdentityResolver`,
> `Change` and `ChangeBuffer` at the bottom of `src/shared/domain.ts`, plus the catalog inputs they
> will need (`TableMeta.primaryKey`, `TableMeta.uniqueIndexes` with an `allColumnsNotNull` flag).
> Everything beyond those declarations lands here.
>
> Two things to check first, because Phase 4 deliberately did not decide them:
> `SchemaService.paginationKeyFor()` already picks a key for **paging** and rejects a nullable unique
> index for the right reason — but it is not `RowIdentityResolver.resolve()`, and the resolver must
> not simply call it. And `default_transaction_read_only` is currently applied per **backend** in
> `session.ts`; lifting it per-transaction means that module and its tests change.

- Implement the editing layer against the types declared in Phase 4: `RowIdentityResolver` (PK/unique detection), `ChangeBuffer` (dirty rows, optimistic concurrency), staged-changes review + commit UI
- Grid side, all additive: a mutable `DataSource` variant with a write method, an `editable`/`readOnly` flag on `ColumnSpec`, `beginEdit`/`commitEdit`/`cancelEdit` on `SelectionEvent`, and a real editor on the existing `overlay` layer (today that layer only draws the column-resize guide)
- Lift `default_transaction_read_only` per-transaction rather than per-connection, so a failed write cannot leave the session writable
- Second driver behind the `Driver` interface (MySQL or SQLite) to prove the abstraction is real and not Postgres-shaped by accident

---

## 7. Critical path

```
Phase 0 ─┬─► Phase 1 ─► Phase 2 ─────────────► Phase 5 ─► Phase 6 ─► Phase 7 ─► Phase 8 ─► Phase 9
         └─► Phase 3 ────────────► Phase 4 ────┘
```

Phase 1+2 (grid) and Phase 3+4 (data) are **independent** and can run in parallel — that is the whole point of the `DataSource` boundary. Roughly **9–12 focused weeks** solo to a signed v1.

The first deliverable you asked for — _simple Electron + Excel-like data grid_ — is **Phase 0 + Phase 1**, about 9–13 days, with zero database work.

---

## 8. Risk register

| Risk                                           | Impact                                             | Likelihood            | Mitigation                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas text measurement kills frame rate       | Grid feels broken                                  | **High**              | Measurement cache from day one; fixed row height; ellipsis by cached width; benchmark harness in Phase 1                                          |
| Electron 44 EOL ~Feb 2027                      | Forced upgrade mid-development                     | **High**              | Calendar the ~8-week cadence; keep main-process code free of Electron-version-specific APIs                                                       |
| `vue-tsc` can't run on TS 7                    | No template type-checking if we bump               | **Certain** if bumped | Pinned to TS 6.0.2 (D5). Revisit only after TS 7.1 API + vue-tsc adoption                                                                         |
| electron-vite blocks Vite 8                    | Miss Rolldown speedups                             | Medium                | Accepted trade-off (D3). Grid perf comes from canvas, not the bundler                                                                             |
| Server-side cursor holds a transaction open    | Bloat, idle-in-transaction timeouts, blocks vacuum | Medium                | `idle_in_transaction_session_timeout`; close cursors aggressively; TTL + LRU in `ResultRegistry`; fall back to keyset pagination when a PK exists |
| 1M-row result blows memory                     | Crash                                              | Medium                | Columnar codec, bounded registry, windowed fetch, never materialise full results in the renderer                                                  |
| A query hangs the UI                           | Unusable app                                       | Medium                | `statement_timeout` + out-of-band `pg_cancel_backend`                                                                                             |
| IME / dead keys broken in the cell editor      | Broken for CJK and some EU users                   | Medium                | `compositionstart/update/end` handling; tested explicitly. (Editor lands in v2, but the overlay layer exists in v1.)                              |
| `devicePixelRatio` change on monitor switch    | Blurry or misaligned canvas                        | Medium                | Re-create canvas backing stores on DPR change                                                                                                     |
| Canvas grid is inaccessible                    | Excludes screen-reader users                       | **High** if ignored   | ARIA proxy grid is a Phase 2 exit criterion, not a nice-to-have                                                                                   |
| Tailwind v4 native binaries (`oxide`) break CI | Build failures                                     | Low                   | Build-time only; pin version; keep a Linux + macOS CI matrix                                                                                      |
| Hand-written SQL lexer has a parsing hole      | Wrong statement splitting, highlight glitches      | Medium                | Property-style tests against a corpus of real-world SQL; splitter failures must fail _safe_ (refuse to run, not run the wrong statement)          |

---

## 9. Open questions

1. **SSH tunnel support** in v1, or deferred? Common in corporate Postgres setups; Node's built-in `net`/`tls` can do it without a third-party SSH lib only if you accept a limited implementation — a real SSH client is a meaningful dependency decision.
2. **Windows/Linux targets** for v1, or macOS only? Affects CI matrix, packaging, and the smoke test. Confirmed dev machine is **arm64/darwin**, so macOS arm64 is the primary target either way.
3. **Package manager**: `npm` 11.19.0 (already present, zero extra tooling) or `pnpm` (faster, stricter, better for a future workspace split)? `corepack` ships with your Node, so pnpm costs one command (`corepack enable pnpm`) and no separate install — but npm keeps the toolchain smaller, which fits §3.
4. **Do you want the grid as a publishable package** eventually? If yes, promote `src/renderer/src/grid` to `packages/grid` in an npm/pnpm workspace during Phase 3 rather than later.
5. **Connection count ceiling** — a handful, or dozens with folders/tags/search? Affects the connection-manager design.
6. **Postgres version floor** to support (13? 15? 17?). Determines which `pg_catalog` features we may use.
7. **Telemetry**: none (recommended), or opt-in crash reporting?

---

## 10. Engineering standards

- **TypeScript** `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`, `moduleResolution: "bundler"`. No `any` without an adjacent `// why:` comment.
- **Modules**: no `"type": "module"` in `package.json` — main and preload build as CJS for maximum `pg` compatibility, renderer is ESM via Vite. (Sandboxed preloads cannot be ESM anyway.)
- **Testing**: pure modules (`GridLayout`, hit-testing, TSV/CSV serialisers, SQL lexer, statement splitter, columnar codec, IPC validators) carry the test weight — they are DOM-free _by design_, which is the payoff of this architecture. Canvas rendering is tested by injecting a **recording mock 2D context** and asserting the draw-call sequence, so no native canvas package is needed.
- **Integration tests** run against a real Postgres from a `docker-compose.yml` (`postgres:17`), gated on an env var and skipped when unavailable.
- **E2E** (optional, later): Playwright's Electron support — a devDependency only.
- **Commits**: Conventional Commits. Small, reviewable units.
- **CI gates** (`.github/workflows/ci.yml`, `macos-14` arm64, 15-min timeout): `npm ci` → `deps:check` → `eslint` → `typecheck` (both projects) → `vitest run` → `build` → `smoke` (prod CSP) → `smoke:dev` → `npm audit --omit=dev` (reported, non-blocking).
