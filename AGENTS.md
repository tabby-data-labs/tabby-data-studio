# AGENTS.md

Rules for AI agents and contributors working in this repository. `PLAN.md` describes _what_ is being
built; `docs/GRID-SPEC.md` describes _how_ the grid behaves. This file describes _how work must be
verified_.

## Commands

```bash
npm run verify   # deps:check + lint + typecheck (node & web) + test + build — the gate
npm test         # vitest run
npm run test:watch
```

Node is nvm-managed. In a non-interactive shell, `node` may not be on `PATH`; source nvm before
concluding a tool is missing:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; node -v
```

## Testing policy — test-first where it pays

### Tier 1: test-first is mandatory (pure logic)

Write the failing test **before** the implementation for any unit whose behaviour is a function of
its inputs, with no DOM, canvas, IPC, or Electron involved:

- `src/shared/**` (domain types, `errors`, `ipc-contract`, `renderer-api`)
- grid `GridLayout` / geometry math, hit-testing, visible-range and frozen-column computation
- the selection reducer (keyboard + mouse transitions)
- clipboard serialisation (TSV/CSV escaping, NULL policy, range chunking)
- text-metric measurement cache and `fit()` cut points
- data-windowing logic (prefetch triggers, in-flight dedupe, stale-request abort)
- `src/main/security/**` and other main-process pure helpers

Rules for Tier 1:

1. Derive expectations from `docs/GRID-SPEC.md` (§7 selection transitions, §13 test strategy) and
   from the stated task — **not** from the implementation you are about to write. A test that mirrors
   the code is not a check.
2. Table-driven cases must include boundary and degenerate inputs: 0 rows, 1 column, negative and
   fractional scroll offsets, max row extent, empty selection, full-range selection.
3. Show the failing test output before implementing (red), then the passing output after (green).
4. Never mock the unit under test. Mock only collaborators (canvas `ctx`, clocks, the `pg` client).
5. Tests live in `tests/unit/*.spec.ts` next to the existing specs; component specs opt into
   `happy-dom` per the docblock convention in `vitest.config.ts`.

### Tier 2: test-after is acceptable (adapters and UI)

Vue components, Electron main-process wiring and IPC handlers, window/CSP setup, styling, and
paint draw-order assertions against a recording mock `ctx`. Writing these tests first tends to
encode a guess about the implementation and forces both files to be rewritten.

Tier 2 still requires tests before the task may be called done — the order is relaxed, the
requirement is not. Exploratory spikes may skip tests entirely, but must not be reported as
complete work.

### Never

- Delete, skip (`it.skip`), or weaken an assertion to reach green. If a test is genuinely wrong, say
  so explicitly and explain why before changing it.
- Report success without running `npm run verify`. Paste real output, including failures. A failing
  gate is a result to report, not a problem to hide.
- Add a third-party dependency to make something testable. Dependencies are deliberately minimal
  here (security posture, and the grid is built from scratch); propose one only with an explicit
  build-vs-buy rationale.

## Definition of done

A task is done when: Tier 1 units have spec-derived tests written first, Tier 2 units have tests,
`npm run verify` passes with output shown, and no unrelated files were modified.
