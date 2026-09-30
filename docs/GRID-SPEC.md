# Tabby — Canvas Data Grid Specification

Back to [`PLAN.md`](../PLAN.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md)

This is the component being built from scratch instead of using a library, so it gets a real spec.
Phases 1–2 in the plan implement §3–§9. §12 is the API the rest of the app codes against.

---

## 1. Goals

|        |                                                                                  |
| ------ | -------------------------------------------------------------------------------- |
| **G1** | 1,000,000 rows × 30 columns, sustained 60fps while scrolling                     |
| **G2** | Frozen header row + N frozen columns, pixel-aligned at fractional scroll offsets |
| **G3** | Excel-grade selection: contiguous + multi-range, mouse and keyboard              |
| **G4** | Copy a range to Excel/Sheets and have it paste as a correct grid                 |
| **G5** | Usable with a screen reader — a canvas alone is invisible to AT                  |
| **G6** | Zero imports from the app; testable headlessly                                   |
| **G7** | Async, windowed data — placeholders while loading, never wrong data              |

### Non-goals (v1)

Cell editing (overlay layer is built, editor is stubbed), variable row heights, cell merging, formulas, pivot, charts, RTL layout (design must not preclude it).

---

## 2. Canvas layer model

Five stacked `<canvas>` elements plus DOM overlays. Splitting them is the core performance decision: **scrolling must not redraw headers**, and **rubber-band dragging must not redraw 30,000 cells**.

| Layer       | Redraws when                   | Contents                                                  |
| ----------- | ------------------------------ | --------------------------------------------------------- |
| `body`      | scroll, data, column change    | zebra stripes → cell text → null markers → gridlines      |
| `colHeader` | horizontal scroll, sort/resize | column names, sort arrows, resize handles                 |
| `rowHeader` | vertical scroll                | row numbers (from absolute row index)                     |
| `corner`    | rarely                         | the frozen intersection cell; "select all"                |
| `overlay`   | selection drag only            | rubber-band rectangle, auto-scroll indicator              |
| DOM         | on demand                      | cell editor, context menu, tooltip, ARIA proxy, scrollbar |

Redraw order within `body` is fixed and back-to-front. Never draw text before the background.

### HiDPI

```ts
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(cssWidth * dpr);
canvas.height = Math.round(cssHeight * dpr);
canvas.style.width = `${cssWidth}px`;
canvas.style.height = `${cssHeight}px`;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // all drawing then uses CSS pixels
```

Listen for DPR changes (`matchMedia(`(resolution: ${dpr}dppx)`)` re-armed on each change) — dragging the window to a different monitor or zooming changes it and silently blurs the canvas if ignored. On change: resize all backing stores and force a full repaint.

Use `ctx.textRendering = 'geometricPrecision'` and disable image smoothing (nothing here is an image).

---

## 3. Coordinate system and layout math

`GridLayout` is a **pure function**. No DOM, no Vue, no state — inputs in, geometry out. This is where nearly all grid bugs live, so it gets nearly all the unit tests.

> **Implemented as `grid/layout.ts` → `computeGeometry()`.** Three amendments to
> the original sketch, all made during Phase 1:
>
> 1. **`rowCount` is a required input.** The sketch omitted it, but `lastRow`,
>    `contentHeight` and `maxScrollTop` cannot be derived without it.
> 2. **`hitTest` returns a discriminated union, not a `{ row: -1 }` sentinel.**
>    The sentinel could not express a row-header click at all, and a union makes
>    unhandled regions a compile error rather than a runtime surprise.
> 3. **Frozen-ness is positional (`frozenColumnCount`), not a per-column flag.**
>    Carrying both invites disagreement between them; deriving `frozen` on each
>    `VisibleCol` removes an entire class of inconsistency bug.

```ts
interface GeometryInput {
  columns: readonly { width: number; visible: boolean }[];
  rowCount: number;
  rowHeight: number; // fixed in v1
  headerHeight: number;
  rowHeaderWidth: number;
  frozenColumnCount: number; // leading *visible* columns
  scrollTop: number;
  scrollLeft: number; // CSS px, fractional allowed
  viewportWidth: number;
  viewportHeight: number;
  overscan?: number; // default 1
}

type HitResult =
  | { kind: 'corner' }
  | { kind: 'colHeader'; col: number }
  | { kind: 'rowHeader'; row: number }
  | { kind: 'cell'; row: number; col: number }
  | { kind: 'outside' };

interface GridGeometry {
  rowCount: number;
  firstRow: number;
  lastRow: number; // inclusive; empty range is firstRow 0, lastRow -1
  firstCol: number;
  lastCol: number;
  rowY(row: number): number; // body-local y
  colX(col: number): number; // body-local x
  visibleRows: { row: number; y: number; height: number }[];
  visibleCols: { col: number; x: number; width: number; frozen: boolean }[];
  frozenWidth: number;
  contentWidth: number; // scrollable columns only
  contentHeight: number; // rowCount * rowHeight
  scrollAreaWidth: number; // bodyWidthPx - frozenWidth
  scrollAreaHeight: number;
  maxScrollLeft: number;
  maxScrollTop: number;
  scrollTop: number; // clamped to [0, max]
  scrollLeft: number;
  originX: number; // == rowHeaderWidth
  originY: number; // == headerHeight
  bodyWidthPx: number;
  bodyHeightPx: number;
  hitTest(x: number, y: number): HitResult; // takes HOST-relative coords
}
```

**The coordinate rule** (the part most likely to be got wrong later): horizontal
coordinates are relative to `originX` and vertical coordinates to `originY`. The
body canvas and the column-header canvas both start at `originX`; the body canvas
and the row-header canvas both start at `originY`. So `colX` is valid on body +
colHeader and `rowY` is valid on body + rowHeader, with no per-layer arithmetic
at the call site. `hitTest` is the inverse and subtracts the origins itself.

Key rules:

- **Rows are fixed-height** in v1. `rowY(r) = r * rowHeight - scrollTop`. O(1) both directions — no accumulation, no binary search. Variable heights would force a prefix-sum index; deliberately out of scope.
- **Frozen columns** are drawn at a fixed `x` in `[0, frozenWidth)` and excluded from `scrollLeft`. Scrollable columns start at `x = frozenWidth`.
- **Overdraw**: extend the visible range by `overscan` rows/columns beyond the viewport so fast scrolling never shows a blank edge.
- **Fractional offsets**: the scroll offset stays fractional so inertia scrolling feels native; 1px rules are snapped to half-pixels (`Math.round(x) + 0.5`) so they are crisp rather than smeared across two device pixels.
- **Clamping is the layout's job.** Negative and past-the-end offsets are clamped inside `computeGeometry`, and `maxScrollTop`/`maxScrollLeft` are exposed so the scroll controller clamps identically. Two independent clamp implementations would drift.
- `hitTest` must invert the frozen/non-frozen split correctly — clicking inside the frozen region maps to a frozen column regardless of `scrollLeft`.
- **Pixels under the frozen band belong to the frozen column.** A scrollable column can be partly scrolled _underneath_ the frozen band; `hitTest` resolves those pixels to the frozen column, and the painter must clip to match (it does — see §4). Getting one of these right and the other wrong produces selection that is offset from what the user clicked.
- **Hidden columns take zero width** and collapse onto their group boundary, so `colX` stays defined for every index and no caller needs a special case.

Total scroll extent is `rowCount * rowHeight`, which for 10M rows is ~300M px — inside float64 range and fine for a synthetic scrollbar, but **do not** try to give a real DOM element that height.

---

## 4. Render pipeline

```
invalidate()  ──►  needsRender = true
                         │
       requestAnimationFrame (one, coalesced)
                         │
                 ┌───────▼────────┐
                 │ measure pass   │  geometry = computeGeometry(state)
                 ├────────────────┤
                 │ data pass      │  for each visible range: cache.getBlock()
                 │                │  missing → request + prefetch, draw placeholder
                 ├────────────────┤
                 │ paint pass     │  bg → text → null → gridlines → selection → frozen shadow
                 └────────────────┘
```

- **Never render directly from an event handler.** Scroll, resize, selection, and data-arrival all just call `invalidate()`. One rAF per frame, and only if dirty.
- One frame must fit in **16.6ms**. Budget: measure 1ms, data lookup 2ms, paint 10ms, headroom 3ms. The benchmark harness (§11) enforces this.
- Clip per cell (`ctx.save(); ctx.beginPath(); ctx.rect(...); ctx.clip()`) only when the text is known to overflow — clipping every cell is expensive. Prefer computing an ellipsis cut from the measurement cache.
- Batch by style: set `fillStyle`/`font` once per group, not per cell. Sort draws so all same-colour text goes together where practical.
- Zebra striping: fill contiguous row bands in one `fillRect` per band, not per cell.

### Text measurement — three tiers, cheapest first

`ctx.measureText` per cell per frame is the single most common canvas-grid performance failure.

> **Phase 1 finding: a measurement cache alone is NOT enough.** Database columns
> are high-cardinality — ids, uuids, timestamps, hashes — so nearly every string
> on screen is new and the cache misses on almost every cell. Measured on the
> 1M×30 benchmark, a cache-only implementation ran at a **96% miss rate
> (343 native `measureText` calls per frame)** and pushed p95 paint to
> **12.1ms, over the 10ms budget**.
>
> The fix is that data grids use a **monospace** font, where width is exact
> arithmetic. Two probes per font (`'i'` vs `'W'`) decide it; once detected,
> width is `text.length * charWidth` and **zero** native measurements happen.
> That took p95 from 12.1ms → **3.4ms** and misses from 343/frame → **0/frame**.

```ts
class TextMetricsCache {
  measure(ctx: MeasureContext, text: string): number;
  fit(ctx, text: string, maxWidth: number): FittedText;
  invalidate(): void; // clears all three tiers
  get stats(): { lookups: number; misses: number };
  resetStats(): void;
}
```

Cost tiers, in order:

1. **Monospace arithmetic** — `text.length * charWidth`, cached per font. The common path.
2. **Measurement cache** — `Map<font\u0000text, width>`, LRU-capped at 10,000. For proportional faces.
3. **Fit cache** — `Map<font\u0000maxWidth\u0000text, FittedText>`. `fit()` otherwise re-runs a binary search that allocates a fresh substring per probe; in a grid the same column repeats its `maxWidth` for every row and enum-like values repeat constantly. Skipped on the monospace path, where the search is already arithmetic and the Map churn would cost more than it saves.

`fit()` returns the **largest** prefix that fits once `…` is appended, and must never exceed `maxWidth`. If even the ellipsis does not fit, it returns `''` with `truncated: true`.

All three tiers are invalidated wholesale on font-family/size/DPR change — a stale entry produces subtly wrong ellipses that are very hard to diagnose later. Note this also drops monospace detection, so the first measure after an invalidate re-pays the two probes.

`stats` exists so the §11 budget is a real measurement. A counter that is declared but never wired up reads `0` and looks like success — that happened here and was caught only because the benchmark asserted the value was non-zero.

---

## 5. Scrolling

- **Wheel / trackpad**: handle `wheel` with `passive: false`, `preventDefault()`, and respect `event.deltaMode` (`DOM_DELTA_LINE` = 1 → multiply by `rowHeight`; `DOM_DELTA_PAGE` = 2 → multiply by viewport). macOS trackpads emit pixel deltas with momentum; do not add your own inertia on top or it doubles up.
- **Shift+wheel** → horizontal scroll.
- **Custom scrollbar** (DOM): native scrollbars cannot represent 10M rows meaningfully and cannot be styled to match. Render a proportional thumb, support drag, click-track-to-page, and keyboard focus. Thumb height is clamped to a minimum of ~24px so it stays grabbable.
- **Programmatic scroll**: `scrollToRow(r, align: 'top'|'center'|'bottom'|'nearest')`, `scrollToCell(r, c)` — used by keyboard nav, "go to row", and find.
- **Auto-scroll during drag selection** when the pointer leaves the viewport, at a speed proportional to the overshoot.

---

## 6. Frozen panes

Frozen header row and first _k_ columns (default: the row-number gutter, plus any the user pins).

- Frozen columns render at a fixed x, ignoring `scrollLeft`; scrollable columns render at `x - scrollLeft + frozenWidth`.
- Draw a 1px separator plus a soft shadow gradient over the first scrollable column **only when `scrollLeft > 0`** — an always-on shadow looks like a rendering bug.
- The `corner` canvas is where frozen header and frozen row-header meet; it hosts "select all".

---

## 7. Selection model

```ts
type CellRef = { row: number; col: number };
type Range = { anchor: CellRef; focus: CellRef }; // normalised on read

interface SelectionState {
  ranges: Range[]; // multi-select; ranges[0] is primary
  mode: 'cell' | 'row' | 'col' | 'all';
  active: CellRef; // the cell an editor/inspector would target
}
```

| Input               | Behaviour                                        |
| ------------------- | ------------------------------------------------ |
| Click               | Replace selection with one cell                  |
| Shift+Click         | Extend primary range to target                   |
| Cmd/Ctrl+Click      | Add/toggle an independent range                  |
| Drag                | Rubber-band on the `overlay` canvas (not `body`) |
| Click column header | Whole column; drag across headers → multiple     |
| Click row header    | Whole row; drag → multiple                       |
| Corner click        | Select all                                       |
| Arrows              | Move active; Shift+arrows extend                 |
| Cmd/Ctrl+Arrows     | Jump to edge of contiguous non-null run          |
| PageUp/Down         | Viewport-height jump                             |
| Home / Cmd+Home     | First column / first cell of sheet               |
| End / Cmd+End       | Last column / last cell of sheet                 |
| Shift+Space         | Select row · Cmd/Ctrl+Space                      | Select column |
| Cmd/Ctrl+A          | All (then again → all rows of current columns)   |
| Esc                 | Clear to single cell                             |
| Tab / Enter         | Move right / down; Shift reverses                |

Selection renders as a translucent fill plus a 2px border on the primary range, and a lighter fill on secondary ranges. The active cell gets a distinct handle square in its corner, exactly like Excel.

---

## 8. Clipboard

Serialise the **union** of selected ranges to a rectangular block:

- **TSV** (`\t` separated, `\r\n` rows) → `navigator.clipboard.writeText`. Excel and Google Sheets both accept this and preserve columns.
- Escaping: a cell containing `\t`, `\n`, or `"` is double-quoted with internal quotes doubled. `NULL` copies as empty by default, configurable to the literal `NULL`.
- Also offer **CSV** (RFC 4180), **JSON** (array of objects), **SQL `INSERT`**, and **Markdown table**.
- Above ~100k cells: show a confirmation with the count, run serialisation off the main render path (chunked across frames or in a Worker), and display progress with cancel.
- Paste is stubbed in v1 (read-only) but the parser should be written now — it is the inverse of the serialiser and will be needed in v2.

---

## 9. Type-aware cell rendering

| Postgres type            | Alignment | Rendering                                                                                                                                           |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NULL` (any)             | left      | italic, muted, the literal `NULL`                                                                                                                   |
| `bool`                   | center    | ☑ / ☐ glyph plus text on hover                                                                                                                      |
| `int2/int4/int8/numeric` | right     | `font-variant-numeric: tabular-nums`. `int8`/`numeric` render from the **string** form — converting to `number` silently loses precision above 2^53 |
| `float4/float8`          | right     | shortest round-trip representation                                                                                                                  |
| `text/varchar/char`      | left      | ellipsis; full value in tooltip + inspector                                                                                                         |
| `timestamptz`            | left      | ISO-8601 in the user's zone; show UTC offset in the inspector                                                                                       |
| `date` / `time`          | left      | ISO                                                                                                                                                 |
| `uuid`                   | left      | full, monospace                                                                                                                                     |
| `json/jsonb`             | left      | `{…}` / `[…]` + a one-line preview; click opens the inspector with a tree view                                                                      |
| `bytea`                  | left      | `<N bytes>` + hex preview of the first 16                                                                                                           |
| arrays                   | left      | `{a,b,c}` truncated                                                                                                                                 |
| parse failure            | left      | inline error styling — **never** throw out of the paint loop                                                                                        |

Column headers show name (bold) + type (muted, smaller) on two lines when the column is wide enough, else name only with the type in a tooltip. Sort indicator is a caret; a sort on a column not in the visible set shows in a status bar chip.

---

## 10. Accessibility (ARIA proxy)

A canvas exposes nothing to assistive tech. Build a proxy:

```html
<div
  class="sr-only"
  role="grid"
  :aria-rowcount="rowCount"
  :aria-colcount="columns.length"
  aria-label="Query result"
>
  <div role="rowgroup">
    <div role="row" v-for="r in visibleRows" :key="r" :aria-rowindex="r + 1">
      <div role="columnheader" v-for="c in columns" :aria-colindex="c + 1">
        {{ columns[c].name }}
      </div>
    </div>
    <div role="row" :aria-rowindex="active.row + 1">
      <div
        role="gridcell"
        v-for="c in columns"
        :aria-colindex="c + 1"
        :aria-selected="isSelected(active.row, c)"
      >
        {{ displayValue(active.row, c) }}
      </div>
    </div>
  </div>
</div>
<div role="status" aria-live="polite">{{ announcement }}</div>
```

- Mirrors only the **visible** window plus the active row, so it stays cheap at any row count.
- `aria-rowcount`/`aria-colcount` carry the true totals; `aria-rowindex`/`aria-colindex` are 1-based absolute positions. **The header row occupies `aria-rowindex` 1**, so data rows start at 2 and `aria-rowcount` is `rowCount + 1`. Getting this wrong makes a screen reader announce every row off by one.
- The grid container is `tabindex="0"` and handles all keyboard input; the proxy is visually hidden but **never `aria-hidden`** — it is the only thing assistive tech can see. The focus element links to it via `aria-describedby`.
- Live region announces on selection change: `"Row 4212 of 1000000, column created_at, 2026-09-23T10:14:00Z"` — throttled so arrow-key repeat does not spam it, and identical consecutive messages are dropped.
- All interactive DOM overlays (context menu, scrollbar, editor) are real focusable elements with correct roles.
- Colour contrast meets WCAG AA in both themes; selection colour must remain distinguishable for the three common colour-vision deficiencies (never rely on red/green alone — pair colour with a glyph).

### Implementation finding: the proxy is a paint-budget problem

Implemented as `grid/aria.ts`. Two rounds of measurement were needed:

| Approach                                            | p50      | p95             | p99          |
| --------------------------------------------------- | -------- | --------------- | ------------ |
| Rebuild every frame                                 | 3.40     | 4.00            | **9.90ms**   |
| Throttle to 10Hz _inside_ the rAF callback          | 2.40     | **8.10–9.60ms** | 8.60–10.50ms |
| 10Hz on an independent timer **+ pooled DOM nodes** | **2.50** | **7.60ms**      | ~8.0ms       |

Throttling alone only _moved_ the spike: whichever frame the rebuild landed on still paid for it.
The real fix was structural — refresh on a timer that never runs inside a paint frame, and **pool the
row/cell elements** instead of recreating ~780 nodes per refresh. Scrolling keeps the window size
constant, so in steady state a refresh allocates nothing and is pure `textContent`/attribute writes
behind a per-row signature check. An idle grid does no work at all.

Corollary worth remembering: **accessibility work has a frame budget too.** "Add an ARIA mirror"
sounds free and cost 25% of the paint budget until it was measured.

**Exit criterion status:** the proxy structure, absolute indices, selected-cell exposure and the live-region
announcement text are all asserted programmatically (26 unit tests + smoke assertions). **A real
VoiceOver pass still requires a human** — structural correctness is necessary but not sufficient for
a good screen-reader experience.

---

## 11. Performance budget and benchmark harness

Perf is a feature that silently rots, so measure it in CI-adjacent tooling from Phase 1.

Implemented as `grid/bench.ts` + `src/main/bench-main.ts`, run via `npm run bench`.

| Metric                                 | Budget            | How measured                                                  | Phase 1 measured (1M×30, 600 frames)         |
| -------------------------------------- | ----------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Paint time per frame                   | p95 < 10ms        | `performance.now()` around the frame callback in `RenderLoop` | **p50 3.0 · p95 3.2–3.4 · p99 3.5–3.7ms** ✅ |
| Frame delivery while scrolling         | 60fps sustained   | rAF count / wall time                                         | **60.0 fps, 1 dropped in 599** ✅            |
| `measureText` calls per frame          | < 2,000           | `TextMetricsCache.stats`                                      | **500 lookups, 0 native misses** ✅          |
| Canvas count                           | 5, never per-cell | static assertion in the smoke harness                         | **5** ✅                                     |
| Time to first paint after data arrives | < 100ms           | mark/measure                                                  | not yet instrumented — Phase 2               |
| Heap after 10 min of scrolling         | no growth trend   | `performance.memory` sampling                                 | not yet instrumented — Phase 2               |

**Two measurement traps found the hard way:**

1. **A benchmark without a warm-up pass measures the wrong thing.** The first run paints skeleton placeholders for blocks that have not arrived, which is far cheaper than painting text. The initial (misleading) reading was p50 5.4ms; adding a warm-up pass revealed the true p95 of 12.1ms, which was _over_ budget and led to the monospace fix in §4.
2. **`sustainedFps` measures rAF delivery, not paint cost**, so it collapses under CPU contention. Observed 24.2fps when the bench was launched immediately after a test run in the same shell, versus 60.0fps in isolation — with near-identical paint timings. Always run `npm run bench` on its own, gate on the paint percentiles, and treat fps as corroboration.

In CI the benchmark is **reported, not blocking**: a 600-frame CPU-bound measurement on a shared runner is too noisy for a hard gate. Run it locally for the gating assertion.

A recording mock 2D context (a Proxy capturing method calls, args, _and_ property assignments as `set:<name>`) makes the paint pass **unit-testable without any native canvas package** — assert the draw-call sequence for a given geometry rather than snapshotting pixels. Recording style assignments too is what lets a test prove "background before text" rather than merely "text was drawn". This keeps the test suite dependency-free, which matters given the project's supply-chain posture.

---

## 12. Public API

```ts
// grid/createDataGrid.ts
export interface DataGridOptions {
  host: HTMLElement; // container; grid appends its own canvases
  source: DataSource; // the ONLY external data dependency
  theme: GridTheme; // colours, fonts, rowHeight, headerHeight
  frozenColumnCount?: number; // default 0
  selection?: SelectionOptions;
  a11y?: { label: string };
  onSelectionChange?(sel: SelectionState): void;
  onCellActivate?(cell: CellRef): void;
  onColumnResize?(col: number, width: number): void;
  onSort?(col: number, dir: 'asc' | 'desc' | null): void;
  onContextMenu?(e: { x: number; y: number; cell: CellRef | null }): void;
}

export interface DataGrid {
  invalidate(): void;
  resize(): void; // re-measure host
  scrollToRow(row: number, align?: ScrollAlign): void;
  scrollToCell(row: number, col: number): void;
  getSelection(): SelectionState;
  setSelection(sel: SelectionState): void;
  copy(format?: ClipboardFormat): Promise<void>;
  setFrozenColumnCount(n: number): void;
  setColumnWidth(col: number, width: number): void;
  autoFitColumn(col: number): void;
  updateTheme(theme: Partial<GridTheme>): void;
  destroy(): void; // removes listeners, canvases, rAF
}
```

The grid owns its DOM subtree and its rAF loop; the Vue component wrapping it is a thin adapter (~80 lines) that mounts/unmounts and forwards Pinia state to `updateTheme` / `source`. **No Vue reactivity inside the grid** — 30,000 reactive cells would destroy the frame budget. Vue drives it through method calls, not bindings.

---

## 13. Test strategy

| Layer          | Tooling                                                                          | What is asserted                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GridLayout`   | Vitest, pure                                                                     | visible ranges, hit-testing at boundaries, frozen-column math, fractional offsets, 0-row and 1-column edge cases, 10M-row extent |
| Text metrics   | Vitest + mock ctx                                                                | cache hit rate, LRU eviction, invalidation on font change, `fit()` cut points                                                    |
| Paint          | Vitest + **recording mock ctx**                                                  | ordered draw-call sequence per layer; no text before background; no `save()` without `restore()`                                 |
| Selection      | Vitest, pure reducer                                                             | every keyboard/mouse transition in §7 as a table-driven test                                                                     |
| Clipboard      | Vitest                                                                           | TSV/CSV escaping round-trip; NULL policy; huge-range chunking                                                                    |
| Data windowing | Vitest + fake timers                                                             | prefetch triggers, in-flight dedupe, abort of stale requests, placeholder on missing block                                       |
| Component      | @vue/test-utils                                                                  | mount/destroy lifecycle, no leaked listeners or rAF                                                                              |
| A11y           | Vitest on the proxy                                                              | `aria-rowindex` correctness at scroll, live-region throttling                                                                    |
| Manual         | macOS VoiceOver, Excel paste, 144Hz + 60Hz displays, external-monitor DPR switch | the things tests cannot catch                                                                                                    |
