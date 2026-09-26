# M1 — Scaffold + Excel-like Canvas Grid

Back to [`PLAN.md`](../PLAN.md)

This is **Phase 0 + Phase 1**: a hardened Electron app that renders a canvas data grid scrolling
through 1,000,000 synthetic rows × 30 columns at 60fps. **No database work at all.**

Target: 9–13 focused days.

> **Status: Phase 0 (Steps 0–8, 10) is complete and verified.** The app boots, the security model is
> asserted by an automated smoke harness, and all gates are green. Steps 2–8 below are now a record
> of what was built rather than instructions to follow. **Phase 1 (Step 9, the grid) is not started.**
> See [M1 exit criteria](#m1-exit-criteria) and
> [deviations found while executing](#deviations-found-while-executing-phase-0).

---

## Step 0 — Verify the toolchain

Already installed via **nvm** (`~/.nvm`, `default` aliased to `24`). Verified 2026-09-23:

|          |                                                         |
| -------- | ------------------------------------------------------- |
| Node     | **v24.21.0** · `~/.nvm/versions/node/v24.21.0/bin/node` |
| npm      | **11.19.0**                                             |
| corepack | present                                                 |
| Platform | arm64 / darwin                                          |

```bash
nvm use default
node -v      # v24.21.0
npm -v       # 11.19.0
```

Nothing to install. Node 24.21.0 is the current Active LTS **and** exactly what Electron 44 bundles,
so host and packaged runtimes agree. Vite 7 requires `^20.19.0 || >=22.12.0`.

Pin it per-directory:

```bash
echo "24" > .nvmrc
```

> ⚠️ **nvm is loaded from `~/.zshrc`, so `node` is not on `PATH` in non-interactive shells.**
> A plain `bash -c 'node -v'` fails even though Node is installed — this is why CI, Git hooks, and
> editor task runners must source nvm explicitly:
>
> ```bash
> export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
> ```
>
> In GitHub Actions, use `actions/setup-node@v4` with `node-version-file: .nvmrc`.

---

## Step 1 — Repository init

```bash
cd /Users/dienastya/Documents/tabby
git init
git add readme.md && git commit -m "chore: initial commit"
```

`.gitignore`:

```gitignore
node_modules/
out/
dist/
*.log
.DS_Store
.env
.env.*
coverage/
```

`.editorconfig`:

```ini
root = true
[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
```

`.npmrc`:

```ini
engine-strict=true
fund=false
audit-level=moderate
```

---

## Step 2 — Install dependencies

Exact versions verified against the npm registry on 2026-09-23.

```bash
# the ONE runtime dependency
npm install --save-exact pg@8.23.0

# build + tooling (never shipped inside the app)
npm install -D \
  electron@44.4.5 \
  electron-vite@5.0.0 \
  electron-builder@26.15.3 \
  vite@7.3.6 \
  @vitejs/plugin-vue@6.0.9 \
  vue@3.5.43 \
  pinia@4.0.3 \
  tailwindcss@4.3.3 \
  @tailwindcss/vite@4.3.3 \
  typescript@6.0.2 \
  vue-tsc@3.3.11 \
  @types/node@^24 \
  @types/pg \
  vitest@5.0.1 \
  @vue/test-utils \
  eslint prettier typescript-eslint \
  eslint-plugin-vue
```

⚠️ **`typescript@6.0.2`, not `7.0.2`.** TypeScript 7.0 is the Go rewrite and ships **no programmatic
API**; `vue-tsc` and `typescript-eslint` both consume that API and cannot run on TS 7. Bumping will
silently cost you Vue template type-checking. Revisit when TS 7.1 ships its API and `vue-tsc` adopts it.

⚠️ **`vite@7.3.6`, not `8.3.0`.** `electron-vite@5.0.0` peer-depends on `vite@^5 || ^6 || ^7`.
Installing Vite 8 produces an unmet-peer warning and an unsupported build. Vite 8 is Rolldown-only
with changed CJS interop — a separate, deliberate migration later.

Then verify the dependency budget immediately:

```bash
npm ls --omit=dev    # must list ONLY pg (+ its 6 transitive deps)
```

---

## Step 3 — `package.json`

Add to the generated file (note: **no `"type": "module"`** — main and preload build as CJS, which is
what `pg` and sandboxed preloads want):

```jsonc
{
  "name": "tabby",
  "version": "0.1.0",
  "private": true,
  "description": "PostgreSQL database viewer",
  "main": "./out/main/index.js",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json",
    "typecheck:web": "vue-tsc --noEmit -p tsconfig.web.json",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "deps:check": "npm ls --omit=dev --depth=10",
    "pack:mac": "electron-vite build && electron-builder --mac",
  },
}
```

No `postinstall: electron-builder install-app-deps` — that exists to rebuild **native** modules, and
this project deliberately has none (`pg` is pure JS). Fewer lifecycle scripts is fewer attack surface.

---

## Step 4 — electron-vite config

`electron.vite.config.ts`:

```ts
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [vue(), tailwindcss()],
  },
});
```

`externalizeDepsPlugin()` is **required** on main and preload: it keeps `pg` out of the bundle so it
resolves from `node_modules` at runtime. Bundling `pg` breaks its dynamic type-parser loading.

---

## Step 5 — TypeScript config

`tsconfig.json` (solution file):

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json` (main + preload + shared):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "composite": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "electron.vite.config.ts"]
}
```

`tsconfig.web.json` (renderer + shared):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "composite": true,
    "useDefineForClassFields": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/renderer/src/*"], "@shared/*": ["src/shared/*"] }
  },
  "include": [
    "src/renderer/src/**/*",
    "src/renderer/src/**/*.vue",
    "src/shared/**/*",
    "src/preload/index.d.ts"
  ]
}
```

Note `@types/node` is scoped to `tsconfig.node.json` only — the renderer must not accidentally use
Node APIs. That is a compile-time guard on a security property.

---

## Step 6 — Main process (hardened from the first commit)

`src/main/index.ts`:

```ts
import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';
import { applyNavigationGuards } from './security/navigation';
import { PROD_CSP } from './security/csp';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false, // reveal on ready-to-show: no white flash
    backgroundColor: '#030b16',
    title: 'Tabby',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [PROD_CSP] },
      });
    });
  }
  applyNavigationGuards();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Nothing in this app spawns windows. External https links go to the browser.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});
```

`src/main/security/csp.ts`:

```ts
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
```

No `unsafe-eval` — Vue 3's runtime-only build needs none. Keep dev and prod CSP as separate
constants so relaxing one can never leak into a shipped build.

`src/main/security/navigation.ts`:

```ts
import { app } from 'electron';

export function applyNavigationGuards(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => event.preventDefault());
  });
}
```

---

## Step 7 — Preload

`src/preload/index.ts`:

```ts
import { contextBridge } from 'electron';

// Minimal in M1; grows into the full typed contract in Phase 3.
const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
} as const;

contextBridge.exposeInMainWorld('tabby', api);
export type TabbyApi = typeof api;
```

`src/preload/index.d.ts`:

```ts
import type { TabbyApi } from './index';

declare global {
  interface Window {
    readonly tabby: TabbyApi;
  }
}
export {};
```

`ipcRenderer` is never exposed. That is a permanent rule, not an M1 simplification.

---

## Step 8 — Renderer

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tabby</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/renderer/src/styles/main.css` — Tailwind v4 is **CSS-first**; there is no `tailwind.config.js`:

```css
@import 'tailwindcss';

@theme {
  --color-surface: #030b16;
  --color-panel: #0a1626;
  --color-border: #1c3a5e;
  --color-accent: #3b76f0;
  --color-text: #e6edf7;
  --color-muted: #8ba0bb;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
}
```

(The palette matches your existing terminal setup — Starship/Catppuccin Mocha with JetBrains Mono.)

`src/renderer/src/main.ts`:

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import './styles/main.css';

createApp(App).use(createPinia()).mount('#app');
```

`src/renderer/src/app/App.vue` mounts `<DataGridVue :source="fakeSource" />` full-bleed.

`src/renderer/src/env.d.ts`:

```ts
/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
```

---

## Step 9 — The grid slice

Build these in this order. Full specification in [`GRID-SPEC.md`](GRID-SPEC.md).

| #   | Module     | File                         | Notes                                                                                                                           |
| --- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Geometry   | `grid/layout.ts`             | Pure `computeGeometry()` + `hitTest()`. **Write the tests first** — §3 of the spec.                                             |
| 2   | Fake data  | `grid/fake-source.ts`        | `DataSource` impl, deterministic 1M×30 typed rows, seeded PRNG.                                                                 |
| 3   | Text cache | `grid/text-metrics.ts`       | LRU `measureText` + `fit()` with ellipsis.                                                                                      |
| 4   | Canvases   | `grid/canvas-layers.ts`      | 5 canvases, HiDPI setup, DPR-change listener.                                                                                   |
| 5   | Painter    | `grid/paint.ts`              | bg → text → null → gridlines → selection → frozen shadow. Takes a `RenderingContext2D` so it is testable with a recording mock. |
| 6   | Loop       | `grid/render-loop.ts`        | dirty-flag + single coalesced rAF.                                                                                              |
| 7   | Scroll     | `grid/scroll.ts`             | wheel w/ `deltaMode`, shift+wheel, custom scrollbar, `scrollToRow`.                                                             |
| 8   | Selection  | `grid/selection.ts`          | pure reducer over events → `SelectionState`. Table-driven tests for every row of spec §7.                                       |
| 9   | Columns    | `grid/columns.ts`            | resize drag, double-click auto-fit, frozen count.                                                                               |
| 10  | Facade     | `grid/createDataGrid.ts`     | the `DataGrid` API in spec §12.                                                                                                 |
| 11  | Adapter    | `components/DataGridVue.vue` | ~80 lines. Mount/destroy, forward theme. **No reactivity inside the grid.**                                                     |

Enforce the boundary with ESLint in `eslint.config.js`:

```js
{
  files: ['src/renderer/src/grid/**/*.{ts,vue}'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: ['@/app/*', '@/components/*', '@/stores/*', '@shared/ipc-contract', 'pinia', 'vue'],
    }],
  },
},
```

The grid may not import Vue. That single rule is what keeps it reusable and headlessly testable.

### Performance benchmark

`grid/bench.ts`, runnable as a dev-only overlay (toggle with a keyboard shortcut):

- Drives a synthetic 600-frame scroll at maximum wheel velocity
- Records rAF deltas → reports p50/p95/p99 frame time and dropped-frame count
- Counts `measureText` calls per frame

Wire it into `npm run test:perf` so a regression is caught before it becomes "the grid feels slow".

---

## Step 10 — Tests

```bash
npm test
```

Minimum M1 coverage:

- `layout.spec.ts` — visible range at scroll 0 / middle / end; hit-test in the frozen region, the
  scrollable region, the header, and outside the grid; 0 rows; 1 column; 10M-row extent
- `selection.spec.ts` — every transition in GRID-SPEC §7 as table-driven cases
- `text-metrics.spec.ts` — cache hit, LRU eviction, invalidation on font change, `fit()` cut points
- `paint.spec.ts` — recording mock ctx: correct draw order, no `save()` without `restore()`,
  no text drawn before its background
- `fake-source.spec.ts` — determinism (same seed → same rows)

---

## M1 exit criteria

### Phase 0 — ✅ complete (2026-09-23)

- [x] `npm run dev` opens a window with no white flash (`backgroundColor` set, shown on `ready-to-show`)
- [x] `npm run typecheck`, `npm run lint`, `npm test` all green — 0 errors, 10 tests passing
- [x] `npm run deps:check` passes: runtime dependencies are exactly `pg@8.23.0`
- [x] `npm run build` produces main / preload / renderer bundles
- [x] `npm run smoke` + `npm run smoke:dev` pass 12 assertions each, with inverse CSP behaviour
- [x] No `require` / `process` / `Buffer` leaked into the renderer; renderer runs `--enable-sandbox`
- [x] All four ESLint boundary rules proven to fire against deliberate violations

### Phase 1 — pending

- [ ] Grid shows 1,000,000 rows × 30 columns of typed fake data with a frozen header row and frozen row-number column
- [ ] Sustained **60fps** (p95 frame < 16.6ms) while scrolling fast, measured by the bench overlay — not eyeballed
- [ ] Frozen panes stay pixel-aligned at fractional scroll offsets
- [ ] Column resize works; double-click auto-fits; no listener or canvas leaks after repeated resizes
- [ ] Click and shift-click selection highlight correctly, including in the frozen region
- [ ] Moving the window to a different-DPI monitor keeps text crisp

### Deferred to Phase 9

- [ ] `npm run pack:mac` produces a `.dmg` that launches on a clean user account. The
      `electron-builder.yml` config is written, but packaging has **not** been executed — it needs an
      app icon in `build/` and a decision on code signing.

---

## Deviations found while executing Phase 0

Recorded so the same traps are not hit again:

1. **`baseUrl` is an error in TS 6, not a warning.** `TS5101: Option 'baseUrl' is deprecated and will
stop functioning in TypeScript 7.0.` Both tsconfigs now use `paths` entries relative to the
   config file (`"./src/shared/*"`), which is the forward-compatible form. This is TS 6 doing its
   job as the bridge release — expect more of these.
2. **Electron 44 has no postinstall script.** Its `package.json` has no `scripts` field at all, so
   `node_modules/electron/dist` is legitimately missing right after `npm ci`. `index.js` downloads
   the binary lazily on first `require('electron')` and verifies it against the bundled
   `checksums.json`. Running `npm install-scripts approve electron` is pointless — there is nothing
   to approve. The first `npm run dev` prints `Downloading Electron binary...` (~300 MB, then cached
   in `~/Library/Caches/electron`).
3. **npm 11 gates dependency install scripts by default.** It warns that `esbuild`, `fsevents`, and
   `electron-winstaller` are "not covered by allowScripts". All three are deliberately left
   unapproved: esbuild resolves its binary through the `@esbuild/darwin-arm64` optional dependency,
   fsevents is an optional watcher optimisation, and electron-winstaller is Windows-only. Everything
   builds, tests, and runs without them.
4. **ESLint flat config ordering is load-bearing.** The last matching block wins, so a `no-console`
   relaxation placed _before_ the global rules block is silently overridden. Relaxations must come
   after.
5. **A boundary rule that matches nothing is worse than no rule.** Each of the four restrictions was
   verified against a temporary violating file, then the probes were deleted and the deletion
   confirmed.

---

## What comes next

**Phase 2** adds the rest of the Excel feel — multi-range selection, keyboard navigation, clipboard
(TSV/CSV/JSON/SQL), context menu, cell inspector, type-aware rendering, and the ARIA proxy grid.

**Phase 3 + 4** (parallelisable with Phase 2) build the Electron IPC contract and the `pg` data layer.

Then **Phase 5** swaps `FakeDataSource` for `RemoteDataSource` — and the exit criterion is that the
grid's own code and tests do not change at all.
