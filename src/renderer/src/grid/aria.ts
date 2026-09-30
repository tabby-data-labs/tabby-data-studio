import type { CellRef, ColumnMeta } from './types';

export interface AriaProxyOptions {
  /** Element the proxy is appended to. */
  readonly container: HTMLElement;
  readonly label: string;
  /** Announcements faster than this are coalesced, so key repeat does not spam. */
  readonly announceThrottleMs?: number;
}

export interface AriaUpdate {
  readonly rowCount: number;
  readonly colCount: number;
  readonly columns: readonly ColumnMeta[];
  /** Absolute row indices currently painted, in order. */
  readonly visibleRows: readonly number[];
  readonly active: CellRef;
  readonly isSelected: (row: number, col: number) => boolean;
  readonly cellText: (row: number, col: number) => string;
}

const HIDDEN_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: '0',
};

let nextId = 0;

function visuallyHidden(element: HTMLElement): void {
  Object.assign(element.style, HIDDEN_STYLE);
}

/**
 * Offscreen `role="grid"` mirroring the visible window (GRID-SPEC §10).
 *
 * A canvas exposes nothing to assistive technology, so without this the grid is
 * completely invisible to a screen reader. The proxy mirrors only the painted
 * window plus the active row, which keeps it O(visible cells) at any row count —
 * a 10M-row result costs the same as a 100-row one.
 *
 * `aria-rowcount` and `aria-colcount` carry the true totals while
 * `aria-rowindex` / `aria-colindex` carry absolute 1-based positions, so a
 * screen reader can say "row 812,344 of 10,000,000" even though only ~30 rows
 * exist in the DOM. Per WAI-ARIA the header row counts as row 1, so data rows
 * start at 2 and `aria-rowcount` is `rowCount + 1`.
 */
export class AriaProxy {
  readonly grid: HTMLDivElement;
  readonly live: HTMLDivElement;

  private readonly rowgroup: HTMLDivElement;
  private readonly headerRow: HTMLDivElement;
  /** Rows currently in the DOM, and their gridcell children. */
  private readonly liveRows: HTMLDivElement[] = [];
  private readonly liveCells: HTMLDivElement[][] = [];
  /** Detached rows kept for reuse, so scrolling does not churn allocations. */
  private readonly spareRows: HTMLDivElement[] = [];
  private readonly spareCells: HTMLDivElement[][] = [];
  private readonly throttleMs: number;
  private lastAnnounce = 0;
  private pendingAnnounce: ReturnType<typeof setTimeout> | null = null;
  private lastAnnounced = '';
  private rowCount = 0;
  private colCount = 0;

  constructor(options: AriaProxyOptions) {
    const id = `tabby-grid-a11y-${(nextId += 1)}`;
    this.throttleMs = Math.max(0, options.announceThrottleMs ?? 150);

    const grid = document.createElement('div');
    grid.id = id;
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', options.label);
    grid.setAttribute('aria-rowcount', '0');
    grid.setAttribute('aria-colcount', '0');
    // Visually hidden but NOT aria-hidden: this subtree is the whole point.
    visuallyHidden(grid);

    const rowgroup = document.createElement('div');
    rowgroup.setAttribute('role', 'rowgroup');
    grid.appendChild(rowgroup);

    const headerRow = document.createElement('div');
    headerRow.setAttribute('role', 'row');
    headerRow.setAttribute('aria-rowindex', '1');
    rowgroup.appendChild(headerRow);

    const live = document.createElement('div');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    visuallyHidden(live);

    options.container.append(grid, live);

    this.grid = grid;
    this.rowgroup = rowgroup;
    this.headerRow = headerRow;
    this.live = live;
  }

  /** The element a sighted keyboard user focuses; wires it to the proxy. */
  describeFocusElement(element: HTMLElement): void {
    element.setAttribute('aria-describedby', this.grid.id);
  }

  update(state: AriaUpdate): void {
    const { rowCount, colCount } = state;

    if (rowCount !== this.rowCount || colCount !== this.colCount) {
      this.rowCount = rowCount;
      this.colCount = colCount;
      // +1 because the header row occupies aria-rowindex 1.
      this.grid.setAttribute('aria-rowcount', String(Math.max(0, rowCount) + 1));
      this.grid.setAttribute('aria-colcount', String(Math.max(0, colCount)));
    }

    this.renderHeader(state);
    this.renderRows(state);
  }

  private renderHeader(state: AriaUpdate): void {
    const header = this.headerRow;
    // Rebuild only when the column set actually changed; rebuilding every frame
    // would churn the accessibility tree and make screen readers lose their place.
    const signature = state.columns.map((column) => column.name).join('\u0000');
    if (header.dataset['signature'] === signature && header.childElementCount > 0) return;
    header.dataset['signature'] = signature;
    header.replaceChildren();

    state.columns.forEach((column, index) => {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'columnheader');
      cell.setAttribute('aria-colindex', String(index + 1));
      cell.textContent = `${column.name} (${column.typeName})`;
      header.appendChild(cell);
    });
  }

  private renderRows(state: AriaUpdate): void {
    const { visibleRows, active, columns } = state;

    // The active row must be present even when scrolled out of the painted
    // window, otherwise the screen reader reads a cell the user is not on.
    const rows = visibleRows.includes(active.row) ? visibleRows : [...visibleRows, active.row];
    const colCount = columns.length;

    this.syncRowCount(rows.length);
    this.syncCellCount(colCount);

    for (let slot = 0; slot < this.liveRows.length; slot += 1) {
      const rowElement = this.liveRows[slot];
      const rowIndex = rows[slot];
      if (!rowElement || rowIndex === undefined) continue;

      // Skip the work entirely when nothing about this row changed, so an idle
      // grid costs one string compare per row instead of a full rewrite.
      const signature = `${rowIndex}:${active.row}:${active.col}`;
      if (rowElement.dataset['signature'] === signature) continue;
      rowElement.dataset['signature'] = signature;
      rowElement.setAttribute('aria-rowindex', String(rowIndex + 2));

      const cells = this.liveCells[slot];
      if (!cells) continue;
      for (let col = 0; col < colCount; col += 1) {
        const cell = cells[col];
        if (!cell) continue;
        const text = state.cellText(rowIndex, col);
        if (cell.textContent !== text) cell.textContent = text;
        if (state.isSelected(rowIndex, col)) cell.setAttribute('aria-selected', 'true');
        else cell.removeAttribute('aria-selected');
      }
    }
  }

  /**
   * Grows or shrinks the mirrored rows, recycling detached elements.
   *
   * Recreating ~780 nodes per refresh held the paint p95 at 8-9ms against a 10ms
   * budget. Scrolling keeps the window size constant, so in steady state this
   * allocates nothing and a refresh is pure textContent/attribute writes.
   */
  private syncRowCount(wanted: number): void {
    while (this.liveRows.length < wanted) {
      const recycled = this.spareRows.pop();
      const rowElement = recycled ?? document.createElement('div');
      if (!recycled) {
        rowElement.setAttribute('role', 'row');
        rowElement.dataset['kind'] = 'data';
      }
      // A recycled row carries a stale signature, so force a rewrite.
      delete rowElement.dataset['signature'];
      this.rowgroup.appendChild(rowElement);
      this.liveRows.push(rowElement);
      this.liveCells.push(this.spareCells.pop() ?? []);
    }

    while (this.liveRows.length > wanted) {
      const rowElement = this.liveRows.pop();
      const cells = this.liveCells.pop();
      if (!rowElement) continue;
      rowElement.remove();
      this.spareRows.push(rowElement);
      if (cells) this.spareCells.push(cells);
    }
  }

  private syncCellCount(colCount: number): void {
    for (let slot = 0; slot < this.liveRows.length; slot += 1) {
      const rowElement = this.liveRows[slot];
      if (!rowElement) continue;
      let cells = this.liveCells[slot];
      if (!cells) {
        cells = [];
        this.liveCells[slot] = cells;
      }

      while (cells.length < colCount) {
        const cell = document.createElement('div');
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colindex', String(cells.length + 1));
        cells.push(cell);
        rowElement.appendChild(cell);
      }
      while (cells.length > colCount) {
        cells.pop()?.remove();
      }
    }
  }

  /**
   * Polite announcement of the active cell. Throttled so holding an arrow key
   * produces one utterance at the end rather than fifty overlapping ones.
   */
  announce(message: string): void {
    if (message === this.lastAnnounced) return;

    const now = Date.now();
    const elapsed = now - this.lastAnnounce;
    if (elapsed >= this.throttleMs) {
      this.lastAnnounce = now;
      this.lastAnnounced = message;
      this.live.textContent = message;
      return;
    }

    this.lastAnnounced = message;
    if (this.pendingAnnounce !== null) clearTimeout(this.pendingAnnounce);
    this.pendingAnnounce = setTimeout(() => {
      this.pendingAnnounce = null;
      this.lastAnnounce = Date.now();
      this.live.textContent = message;
    }, this.throttleMs - elapsed);
  }

  destroy(): void {
    if (this.pendingAnnounce !== null) clearTimeout(this.pendingAnnounce);
    this.pendingAnnounce = null;
    this.grid.remove();
    this.live.remove();
  }
}
