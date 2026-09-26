# Tabby

A desktop PostgreSQL database viewer with a from-scratch, Excel-like canvas data grid.

**Stack:** Electron 44 · Vue 3.5 · Vite 7 · Tailwind 4 · TypeScript 6 · `pg` (the only runtime dependency)

## Documentation

| Document | Contents |
|---|---|
| [`PLAN.md`](PLAN.md) | Locked decisions, verified version matrix, dependency budget, scope, 10-phase roadmap, risk register |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Process model, folder layout, IPC contract, `DataSource` boundary, `pg` data layer, security hardening |
| [`docs/GRID-SPEC.md`](docs/GRID-SPEC.md) | Canvas grid: layer model, layout math, render pipeline, selection, clipboard, accessibility, perf budget |
| [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md) | Executable first build — scaffold plus the 1M-row canvas grid |

## Status

Planning complete. **M1 not started** — see [`docs/M1-SCAFFOLD.md`](docs/M1-SCAFFOLD.md) for the first build.

## Prerequisites

Node.js **24.x**, managed by nvm — already installed and verified:

| | |
|---|---|
| Node | v24.21.0 (`~/.nvm`, Active LTS, matches Electron 44's bundled Node) |
| npm | 11.19.0 |
| Platform | arm64 / darwin |

```bash
nvm use default && node -v
```

Note: nvm loads from `~/.zshrc`, so `node` is absent from `PATH` in non-interactive shells (CI, Git
hooks, editor tasks). Those must source nvm explicitly.
