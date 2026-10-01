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

**Phases 0–3 complete** — a hardened Electron shell, a from-scratch canvas data grid that scrolls
**1,000,000 rows × 30 columns at a measured 60fps** and behaves like Excel (pointer and keyboard
selection, five clipboard formats, context menu, cell inspector, ARIA proxy grid), and a real
three-process IPC contract with validated payloads and keychain-encrypted credentials.
No database queries yet — Phase 4 wires up `pg`.

| Check                         | Result                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run deps:check`          | ✅ runtime deps = `pg@8.23.0` only                                                                                                          |
| `npm run lint`                | ✅ 0 errors, 0 warnings                                                                                                                     |
| `npm run typecheck`           | ✅ node + web projects                                                                                                                      |
| `npm test`                    | ✅ **542 tests**, 22 files                                                                                                                  |
| `npm run build`               | ✅ main (3 entries) · preload · renderer                                                                                                    |
| `npm run smoke` (prod CSP)    | ✅ **59/59 assertions** — paints, `eval` + inline scripts **blocked**, keyboard nav, copy, IPC round-trip and 8/8 hostile payloads rejected |
| `npm run smoke:dev` (dev CSP) | ✅ **59/59** — both correctly **allowed** under the dev policy                                                                              |
| `npm run bench`               | ✅ p50 2.60 · **p95 7.40ms** vs 10ms budget · **60.0 fps** · 1 dropped in 599                                                               |

Runtime confirmed as **Electron 44.4.5 / Chromium 152.0.7977.130 / Node 24.21.0**, with no
`require`, `process`, `Buffer`, or `ipcRenderer` leaking into the renderer, `window.tabby` frozen,
and a one-entry permission allowlist (`clipboard-sanitized-write`) that denies everything else.

Passwords are stored as `safeStorage` ciphertext and refused outright when no OS keychain is
available — never written in plaintext as a fallback. Every log line passes through a redactor.

The grid is 22 modules / ~5,000 lines in `src/renderer/src/grid/`, importing nothing from the app —
enforced by an ESLint boundary rule so it stays headlessly testable and extractable.

**Not yet verified by a human:** a real VoiceOver pass over the ARIA proxy, macOS full-screen
restore, and text crispness when dragging to a different-DPI monitor. All are implemented and
asserted structurally in code, but need eyes.

## Getting started

```bash
nvm use
npm install
npm run dev        # Vite dev server + Electron with HMR
```

```bash
npm run verify     # deps:check + lint + typecheck + test + build
npm run smoke      # boots real Electron, asserts the security model
npm run bench      # 600-frame scroll benchmark — run on an otherwise idle machine
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
