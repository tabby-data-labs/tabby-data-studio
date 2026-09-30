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

**However:** v1 must not make v2 expensive. The interfaces in `docs/ARCHITECTURE.md` §6 are designed so cell editing is _additive_ — a `RowIdentityResolver`, a `ChangeBuffer`, and a mutable `DataSource` variant — rather than a rewrite.

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

### Phase 3 — Electron shell & IPC · 5 days · ◄── NEXT

**Goal:** the hardened three-process contract is real, not a stub.

- Preload exposes a frozen, typed `window.tabby`; raw `ipcRenderer` never leaks
- IPC contract types in `src/shared/ipc-contract.ts`, one source of truth for both sides
- Hand-written boundary validators (~120 lines) in main — no third-party schema lib
- Settings store: connections list, window geometry, theme; passwords encrypted with `safeStorage`
- Window state persistence; macOS full-screen and restore behaviour
- Tab UI shell (result tabs, query tabs)

**Exit criteria:** renderer can round-trip a validated request; malformed/hostile IPC payloads are rejected and logged; passwords are ciphertext at rest and never appear in logs or DevTools.

### Phase 4 — Postgres data layer · 8–12 days

**Goal:** real queries, positionable and bounded, and provably read-only.

- `ConnectionManager`: one small `pg.Pool` per saved connection, lazy connect, health checks, clean teardown
- **Read-only enforcement on connect:** `SET default_transaction_read_only = on`. Server-side, so even a bug in our SQL generation cannot write. Document creating a read-only DB role as the belt-and-braces option.
- Session limits: `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`
- SSL config with explicit `rejectUnauthorized`; no silent trust
- Identifier handling: a `quoteIdent` that validates against a safe character class and doubles `"` — never naive concatenation
- Schema introspection against `pg_catalog` (`pg_namespace`, `pg_class`, `pg_attribute`, `pg_type`, `pg_index`, `pg_constraint`, `pg_description`) with per-connection caching and manual/explicit invalidation
- **Positionable large results:** `BEGIN` + `DECLARE <name> CURSOR FOR <query>` + `FETCH`/`MOVE ABSOLUTE`, so the grid can jump to row 800,000 without `OFFSET` scanning a million rows
- `ResultRegistry`: `resultId` → cursor + column metadata; bounded count, TTL, LRU eviction, memory cap
- `query:cancel` via a **second** connection running `pg_cancel_backend(pid)` — you cannot cancel on the connection that is busy
- Columnar transfer codec: `{ columns, rowCount, columns: TypedArray[] }`, transferring `ArrayBuffer`s over structured clone instead of shipping 1M row objects
- Row count: `pg_class.reltuples` estimate instantly, exact `count(*)` in the background on request

**Exit criteria:** a `SELECT` over a 10M-row table returns its first 1000 rows in <500ms of client overhead; jumping to an arbitrary row offset works; cancelling a long query returns the UI to responsive within 200ms; `default_transaction_read_only` is verified on by a test that asserts an `INSERT` attempt fails with SQLSTATE `25006`; the registry never exceeds its memory cap under a soak test.

### Phase 5 — Grid on live data · 5 days

**Goal:** swap `FakeDataSource` for the IPC-backed one without touching grid code.

- `RemoteDataSource implements DataSource`: windowed fetch by row range, read-ahead prefetch of adjacent blocks, in-flight dedupe, stale-response cancellation
- Loading skeletons, per-range error surfaces, retry
- Server-side sorting (re-query with `ORDER BY`, never client-side sort of a partial window)
- Connection-loss and cursor-invalidation recovery

**Exit criteria:** the grid module's public API and its unit tests are **unchanged** from Phase 2 — proof the boundary held. Fast-scrolling a 10M-row table shows placeholders, never wrong data, and never blocks the main thread.

### Phase 6 — Schema explorer · 5 days

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

- Implement the editing layer against the interfaces stubbed in Phase 4/5: `RowIdentityResolver` (PK/unique detection), `ChangeBuffer` (dirty rows, optimistic concurrency), staged-changes review + commit UI
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
