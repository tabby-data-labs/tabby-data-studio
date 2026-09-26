# Tabby — Canvas Data Grid Specification

Back to [`PLAN.md`](../PLAN.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md)

This is the component being built from scratch instead of using a library, so it gets a real spec.
Phases 1–2 in the plan implement §3–§9. §12 is the API the rest of the app codes against.

---

## 1. Goals

| | |
|---|---|
| **G1** | 1,000,000 rows × 30 columns, sustained 60fps while scrolling |
| **G2** | Frozen header row + N frozen columns, pixel-aligned at fractional scroll offsets |
| **G3** | Excel-grade selection: contiguous + multi-range, mouse and keyboard |
| **G4** | Copy a range to Excel/Sheets and have it paste as a correct grid |
| **G5** | Usable with a screen reader — a canvas alone is invisible to AT |
| **G6** | Zero imports from the app; testable headlessly |
| **G7** | Async, windowed data — placeholders while loading, never wrong data |

### Non-goals (v1)

Cell editing (overlay layer is built, editor is stubbed), variable row heights, cell merging, formulas, pivot, charts, RTL layout (design must not preclude it).

---

## 2. Canvas layer model

Five stacked `<canvas>` elements plus DOM overlays. Splitting them is the core performance decision: **scrolling must not redraw headers**, and **rubber-band dragging must not redraw 30,000 cells**.

| Layer | Redraws when | Contents |
|---|---|---|
| `body` | scroll, data, column change | zebra stripes → cell text → null markers → gridlines |
| `colHeader` | horizontal scroll, sort/resize | column names, sort arrows, resize handles |
| `rowHeader` | vertical scroll | row numbers (from absolute row index) |
| `corner` | rarely | the frozen intersection cell; "select all" |
| `overlay` | selection drag only | rubber-band rectangle, auto-scroll indicator |
| DOM | on demand | cell editor, context menu, tooltip, ARIA proxy, scrollbar |

Redraw order within `body` is fixed and back-to-front. Never draw text before the background.

### HiDPI

```ts
const dpr = window.devicePixelRatio || 1;
canvas.width  = Math.round(cssWidth  * dpr);
canvas.height = Math.round(cssHeight * dpr);
canvas.style.width  = `${cssWidth}px`;
canvas.style.height = `${cssHeight}px`;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // all drawing then uses CSS pixels
```

Listen for DPR changes (`matchMedia(`(resolution: ${dpr}dppx)`)` re-armed on each change) — dragging the window to a different monitor or zooming changes it and silently blurs the canvas if ignored. On change: resize all backing stores and force a full repaint.

Use `ctx.textRendering = 'geometricPrecision'` and disable image smoothing (nothing here is an image).

---

## 3. Coordinate system and layout math

`GridLayout` is a **pure function**. No DOM, no Vue, no state — inputs in, geometry out. This is where nearly all grid bugs live, so it gets nearly all the unit tests.

```ts
interface GridGeometryInput {
  columns: readonly { width: number; frozen: boolean; visible: boolean }[];
  rowHeight: number;                 // fixed in v1
  headerHeight: number;
  rowHeaderWidth: number;
  frozenColumnCount: number;
  scrollTop: number; scrollLeft: number;   // CSS px, fractional allowed
  viewportWidth: number; viewportHeight: number;
}

interface GridGeometry {
  firstRow: number; lastRow: number;       // inclusive, absolute indices
  firstCol: number; lastCol: number;
  rowY(row: number): number;               // absolute row → CSS y in body space
  colX(col: number): number;
  visibleRows: { row: number; y: number; height: number }[];
  visibleCols: { col: number; x: number; width: number; frozen: boolean }[];
  frozenWidth: number;                     // total px of frozen columns
  bodyHeight: number; bodyWidth: number;   // scrollable content extents
  hitTest(x: number, y: number): { row: number; col: number } | { row: -1; col: number } | null;
}
```

Key rules:

- **Rows are fixed-height** in v1. `rowY(r) = r * rowHeight - scrollTop`. O(1) both directions — no accumulation, no binary search. Variable heights would force a prefix-sum index; deliberately out of scope.
- **Frozen columns** are drawn at a fixed `x` in `[0, frozenWidth)` and excluded from `scrollLeft`. Scrollable columns start at `x = frozenWidth`.
- **Overdraw**: extend the visible range by 1 row/column beyond the viewport so fast scrolling never shows a blank edge.
- **Fractional offsets**: snap text drawing to integer device pixels (`Math.round(y * dpr) / dpr`) to avoid blurry glyphs, but keep the scroll offset itself fractional so inertia scrolling feels native.
- `hitTest` must invert the frozen/non-frozen split correctly — clicking inside the frozen region maps to a frozen column regardless of `scrollLeft`.

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

### Text measurement cache

`ctx.measureText` per cell per frame is the single most common canvas-grid performance failure.

```ts
class TextMetrics {
  private cache = new Map<string, number>();     // `${fontKey}\u0000${text}` → width px
  measure(ctx: CanvasRenderingContext2D, text: string): number;
  fit(ctx, text: number, maxWidth: number): { text: string; truncated: boolean };
  clear(): void;                                  // on font or DPR change
}
```

LRU-cap at ~10,000 entries. `fit()` binary-searches the cut point and appends `…`. Cache is invalidated wholesale on font-family/size/DPR change — a stale cache produces subtly wrong ellipses that are very hard to diagnose later.

---

## 5. Scrolling

- **Wheel / trackpad**: handle `wheel` with `passive: false`, `preventDefault()`, and respect `event.deltaMode` (`DOM_DELTA_LINE` = 1 → multiply by `rowHeight`; `DOM_DELTA_PAGE` = 2 → multiply by viewport). macOS trackpads emit pixel deltas with momentum; do not add your own inertia on top or it doubles up.
- **Shift+wheel** → horizontal scroll.
- **Custom scrollbar** (DOM): native scrollbars cannot represent 10M rows meaningfully and cannot be styled to match. Render a proportional thumb, support drag, click-track-to-page, and keyboard focus. Thumb height is clamped to a minimum of ~24px so it stays grabbable.
- **Programmatic scroll**: `scrollToRow(r, align: 'top'|'center'|'bottom'|'nearest')`, `scrollToCell(r, c)` — used by keyboard nav, "go to row", and find.
- **Auto-scroll during drag selection** when the pointer leaves the viewport, at a speed proportional to the overshoot.

---

## 6. Frozen panes

Frozen header row and first *k* columns (default: the row-number gutter, plus any the user pins).

- Frozen columns render at a fixed x, ignoring `scrollLeft`; scrollable columns render at `x - scrollLeft + frozenWidth`.
- Draw a 1px separator plus a soft shadow gradient over the first scrollable column **only when `scrollLeft > 0`** — an always-on shadow looks like a rendering bug.
- The `corner` canvas is where frozen header and frozen row-header meet; it hosts "select all".

---

## 7. Selection model

```ts
type CellRef = { row: number; col: number };
type Range   = { anchor: CellRef; focus: CellRef };   // normalised on read

interface SelectionState {
  ranges: Range[];          // multi-select; ranges[0] is primary
  mode: 'cell' | 'row' | 'col' | 'all';
  active: CellRef;          // the cell an editor/inspector would target
}
```

| Input | Behaviour |
|---|---|
| Click | Replace selection with one cell |
| Shift+Click | Extend primary range to target |
| Cmd/Ctrl+Click | Add/toggle an independent range |
| Drag | Rubber-band on the `overlay` canvas (not `body`) |
| Click column header | Whole column; drag across headers → multiple |
| Click row header | Whole row; drag → multiple |
| Corner click | Select all |
| Arrows | Move active; Shift+arrows extend |
| Cmd/Ctrl+Arrows | Jump to edge of contiguous non-null run |
| PageUp/Down | Viewport-height jump |
| Home / Cmd+Home | First column / first cell of sheet |
| End / Cmd+End | Last column / last cell of sheet |
| Shift+Space | Select row · Cmd/Ctrl+Space | Select column |
| Cmd/Ctrl+A | All (then again → all rows of current columns) |
| Esc | Clear to single cell |
| Tab / Enter | Move right / down; Shift reverses |

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

| Postgres type | Alignment | Rendering |
|---|---|---|
| `NULL` (any) | left | italic, muted, the literal `NULL` |
| `bool` | center | ☑ / ☐ glyph plus text on hover |
| `int2/int4/int8/numeric` | right | `font-variant-numeric: tabular-nums`. `int8`/`numeric` render from the **string** form — converting to `number` silently loses precision above 2^53 |
| `float4/float8` | right | shortest round-trip representation |
| `text/varchar/char` | left | ellipsis; full value in tooltip + inspector |
| `timestamptz` | left | ISO-8601 in the user's zone; show UTC offset in the inspector |
| `date` / `time` | left | ISO |
| `uuid` | left | full, monospace |
| `json/jsonb` | left | `{…}` / `[…]` + a one-line preview; click opens the inspector with a tree view |
| `bytea` | left | `<N bytes>` + hex preview of the first 16 |
| arrays | left | `{a,b,c}` truncated |
| parse failure | left | inline error styling — **never** throw out of the paint loop |

Column headers show name (bold) + type (muted, smaller) on two lines when the column is wide enough, else name only with the type in a tooltip. Sort indicator is a caret; a sort on a column not in the visible set shows in a status bar chip.

---

## 10. Accessibility (ARIA proxy)

A canvas exposes nothing to assistive tech. Build a proxy:

```html
<div class="sr-only" role="grid"
     :aria-rowcount="rowCount" :aria-colcount="columns.length" aria-label="Query result">
  <div role="rowgroup">
    <div role="row" v-for="r in visibleRows" :key="r" :aria-rowindex="r + 1">
      <div role="columnheader" v-for="c in columns" :aria-colindex="c + 1">{{ columns[c].name }}</div>
    </div>
    <div role="row" :aria-rowindex="active.row + 1">
      <div role="gridcell" v-for="c in columns" :aria-colindex="c + 1"
           :aria-selected="isSelected(active.row, c)">{{ displayValue(active.row, c) }}</div>
    </div>
  </div>
</div>
<div role="status" aria-live="polite">{{ announcement }}</div>
```

- Mirrors only the **visible** window plus the active row, so it stays cheap at any row count.
- `aria-rowcount`/`aria-colcount` carry the true totals; `aria-rowindex`/`aria-colindex` are 1-based absolute positions.
- The grid container is `tabindex="0"` and handles all keyboard input; the proxy is `aria-hidden` from tab order.
- Live region announces on selection change: `"Row 4212, column created_at, 2026-09-23T10:14:00Z"` — throttled so arrow-key repeat does not spam it.
- All interactive DOM overlays (context menu, scrollbar, editor) are real focusable elements with correct roles.
- Colour contrast meets WCAG AA in both themes; selection colour must remain distinguishable for the three common colour-vision deficiencies (never rely on red/green alone — pair colour with a glyph).

**Exit criterion in Phase 2:** VoiceOver can navigate to and read a cell's row, column, and value.

---

## 11. Performance budget and benchmark harness

Perf is a feature that silently rots, so measure it in CI-adjacent tooling from Phase 1.

| Metric | Budget | How measured |
|---|---|---|
| Frame time while scrolling 1M×30 | p95 < 16.6ms | rAF timestamp deltas over 600 frames |
| Paint time per frame | < 10ms | `performance.mark` around the paint pass |
| `measureText` calls per frame | < 2,000 | counter on the cache |
| Time to first paint after data arrives | < 100ms | mark/measure |
| Heap after 10 min of scrolling | no growth trend | `performance.memory` sampling |
| Canvas count | 5, never per-cell | static assertion |

A recording mock 2D context (a plain object capturing method calls and args) makes the paint pass **unit-testable without any native canvas package** — assert the draw-call sequence for a given geometry rather than snapshotting pixels. This keeps the test suite dependency-free, which matters given the project's supply-chain posture.

---

## 12. Public API

```ts
// grid/createDataGrid.ts
export interface DataGridOptions {
  host: HTMLElement;              // container; grid appends its own canvases
  source: DataSource;             // the ONLY external data dependency
  theme: GridTheme;               // colours, fonts, rowHeight, headerHeight
  frozenColumnCount?: number;     // default 0
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
  resize(): void;                                    // re-measure host
  scrollToRow(row: number, align?: ScrollAlign): void;
  scrollToCell(row: number, col: number): void;
  getSelection(): SelectionState;
  setSelection(sel: SelectionState): void;
  copy(format?: ClipboardFormat): Promise<void>;
  setFrozenColumnCount(n: number): void;
  setColumnWidth(col: number, width: number): void;
  autoFitColumn(col: number): void;
  updateTheme(theme: Partial<GridTheme>): void;
  destroy(): void;                                   // removes listeners, canvases, rAF
}
```

The grid owns its DOM subtree and its rAF loop; the Vue component wrapping it is a thin adapter (~80 lines) that mounts/unmounts and forwards Pinia state to `updateTheme` / `source`. **No Vue reactivity inside the grid** — 30,000 reactive cells would destroy the frame budget. Vue drives it through method calls, not bindings.

---

## 13. Test strategy

| Layer | Tooling | What is asserted |
|---|---|---|
| `GridLayout` | Vitest, pure | visible ranges, hit-testing at boundaries, frozen-column math, fractional offsets, 0-row and 1-column edge cases, 10M-row extent |
| Text metrics | Vitest + mock ctx | cache hit rate, LRU eviction, invalidation on font change, `fit()` cut points |
| Paint | Vitest + **recording mock ctx** | ordered draw-call sequence per layer; no text before background; no `save()` without `restore()` |
| Selection | Vitest, pure reducer | every keyboard/mouse transition in §7 as a table-driven test |
| Clipboard | Vitest | TSV/CSV escaping round-trip; NULL policy; huge-range chunking |
| Data windowing | Vitest + fake timers | prefetch triggers, in-flight dedupe, abort of stale requests, placeholder on missing block |
| Component | @vue/test-utils | mount/destroy lifecycle, no leaked listeners or rAF |
| A11y | Vitest on the proxy | `aria-rowindex` correctness at scroll, live-region throttling |
| Manual | macOS VoiceOver, Excel paste, 144Hz + 60Hz displays, external-monitor DPR switch | the things tests cannot catch |
