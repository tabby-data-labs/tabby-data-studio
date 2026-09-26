# Tabby

A desktop PostgreSQL database viewer with a from-scratch, Excel-like canvas data grid.

**Stack:** Electron 44 · Vue 3.5 · Vite 7 · Tailwind 4 · TypeScript 6 · `pg` (the only runtime dependency)

## Documentation

| Document                                       | Contents                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`PLAN.md`](PLAN.md)                           | Locked decisions, verified version matrix, dependency budget, scope, 10-phase roadmap, risk register     |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Process model, folder layout, IPC contract, `DataSource` boundary, `pg` data layer, security hardening   |
| [`docs/GRID-SPEC.md`](docs/GRID-SPEC.md)       | Canvas grid: layer model, layout math, render pipeline, selection, clipboard, accessibility, perf budget |
| [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md)   | Executable first build — scaffold plus the 1M-row canvas grid                                            |

## Status

**Phase 0 complete** (2026-09-23) — scaffold, hardened Electron shell, tooling, and CI all verified
green. Phase 1 (the canvas data grid) is next.

| Check                         | Result                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `npm run deps:check`          | ✅ runtime deps = `pg@8.23.0` only                                 |
| `npm run lint`                | ✅ 0 errors, 0 warnings                                            |
| `npm run typecheck`           | ✅ node + web projects                                             |
| `npm test`                    | ✅ 10 tests                                                        |
| `npm run build`               | ✅ main 1.47 kB · preload 0.29 kB · renderer 194 kB + 9.28 kB CSS  |
| `npm run smoke` (prod CSP)    | ✅ 12 assertions — `eval` and inline scripts **blocked**           |
| `npm run smoke:dev` (dev CSP) | ✅ 12 assertions — both correctly **allowed** under the dev policy |

Runtime confirmed as **Electron 44.4.5 / Chromium 152.0.7977.130 / Node 24.21.0**, with no
`require`, `process`, or `Buffer` leaking into the renderer.

## Getting started

```bash
nvm use
npm install
npm run dev        # Vite dev server + Electron with HMR
```

```bash
npm run verify     # deps:check + lint + typecheck + test + build
npm run smoke      # boots real Electron, asserts the security model
npm run pack:mac   # produce a .dmg (Phase 9)
```

The first Electron invocation downloads the ~300 MB binary on demand — see the note under
Prerequisites.

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
