/**
 * The schema tree's model: flattening, windowing, filtering and keyboard
 * navigation (PLAN Phase 6).
 *
 * Hand-built, and deliberately **not** a reuse of `src/renderer/src/grid/`. The
 * grid is a canvas with a frozen-column model, a two-axis scroll extent and a
 * paint pipeline; a tree is a one-axis list of DOM rows. What is reused is the
 * *concept* — compute the visible window from a scroll offset and render only
 * that — not the code, which is why nothing here imports from `@/grid`.
 *
 * The split that makes 2,000 tables scroll smoothly:
 *
 *   {@link flattenRows}   runs when the tree's contents change — expand, load,
 *                         collapse, filter. O(nodes), and those events are rare.
 *   {@link virtualWindow} runs on every scroll frame. O(1) in the row count.
 *
 * A scroll therefore never re-walks the tree, and the cost of scrolling a
 * 2,000-table schema is identical to the cost of scrolling a 20-table one.
 */
import type { SchemaNode, SchemaNodeKind } from '@shared/domain';

/**
 * Segment separator for node ids.
 *
 * NUL cannot appear in a Postgres identifier — `quoteIdent` refuses it — so
 * `childNodeId` is injective: `a.b` as one name and `a` + `b` as two produce
 * different ids. Any printable separator would let those collide.
 */
export const ID_SEPARATOR = '\u0000';

export const DEFAULT_ROW_HEIGHT = 22;
/** Rows rendered outside the viewport, so a fast flick does not show blanks. */
export const DEFAULT_OVERSCAN = 6;

export type TreeNodeKind = SchemaNodeKind | 'connection';

export function connectionNodeId(connectionId: string): string {
  return connectionId;
}

export function childNodeId(parentId: string, name: string): string {
  return `${parentId}${ID_SEPARATOR}${name}`;
}

/** True when `candidateId` is strictly below `ancestorId`. Answers from the id alone. */
export function isDescendantOf(candidateId: string, ancestorId: string): boolean {
  return candidateId.startsWith(`${ancestorId}${ID_SEPARATOR}`);
}

export interface TreeRoot {
  readonly id: string;
  readonly connectionId: string;
  readonly label: string;
  readonly expandable: boolean;
}

export interface TreeRow {
  readonly id: string;
  readonly depth: number;
  readonly kind: TreeNodeKind;
  readonly label: string;
  /**
   * The schema a relation belongs to, and `''` for connection and schema rows.
   * Blank for a schema row on purpose: its qualified form would otherwise read
   * `fixtures.fixtures`, and a filter for `fixtures.public` would match it.
   */
  readonly schema: string;
  readonly connectionId: string;
  readonly oid: number;
  readonly comment: string | null;
  /** -1 when unknown, matching `SchemaNode.rowEstimate`. */
  readonly rowEstimate: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  /** Children have never been requested. Distinct from "loaded and empty". */
  readonly unloaded: boolean;
  /**
   * How many children this node has, or -1 when they have not been loaded.
   *
   * Carried so the UI can distinguish a schema that is genuinely empty from one
   * that has not been read yet — without those being the same `(empty)` label,
   * which would tell the user a database has no tables when it has not looked.
   */
  readonly childCount: number;
}

/**
 * The subset of {@link TreeRow} that a child load needs.
 *
 * Exists so the store can seed a load for a node it has not flattened yet — a
 * refresh reloading the schemas that were open, or the initial root load — without
 * inventing a whole `TreeRow` or casting a partial one.
 */
export interface LoadTarget {
  readonly id: string;
  readonly kind: TreeNodeKind;
  readonly label: string;
  readonly expandable: boolean;
}

/**
 * Everything {@link flattenRows} reads, as plain immutable data.
 *
 * Sets and a Map rather than callbacks: a pure function over data can be called
 * from a `computed` and be correctly tracked by Vue, and it cannot smuggle a
 * side effect into a render.
 */
export interface TreeInput {
  readonly roots: readonly TreeRoot[];
  readonly children: ReadonlyMap<string, readonly SchemaNode[]>;
  readonly expanded: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
}

export interface FlattenOptions {
  /**
   * Render every loaded node as expanded. The filter turns this on: a match whose
   * ancestors are collapsed is a match the user cannot see.
   */
  readonly expandAll?: boolean;
}

function isExpanded(
  input: TreeInput,
  id: string,
  expandable: boolean,
  expandAll: boolean,
): boolean {
  // A leaf is never "expanded", even if its id is still in the set from before a
  // refresh told us it has no children. Rendering a caret that cannot collapse
  // would leave the keyboard contract ambiguous.
  return expandable && (expandAll || input.expanded.has(id));
}

/**
 * The visible rows, in pre-order.
 *
 * Only the children of **expanded** nodes are walked, so a collapsed schema with
 * 2,000 loaded tables costs one row. That is the first half of the perf story;
 * {@link virtualWindow} is the second.
 */
export function flattenRows(input: TreeInput, options: FlattenOptions = {}): readonly TreeRow[] {
  const expandAll = options.expandAll === true;
  const rows: TreeRow[] = [];

  const push = (
    id: string,
    depth: number,
    kind: TreeNodeKind,
    label: string,
    schema: string,
    connectionId: string,
    oid: number,
    comment: string | null,
    rowEstimate: number,
    expandable: boolean,
  ): void => {
    const expanded = isExpanded(input, id, expandable, expandAll);
    const children = input.children.get(id);
    const childCount = children === undefined ? -1 : children.length;
    rows.push({
      id,
      depth,
      kind,
      label,
      schema,
      connectionId,
      oid,
      comment,
      rowEstimate,
      expandable,
      expanded,
      loading: input.loading.has(id),
      failed: input.failed.has(id),
      unloaded: expandable && childCount < 0,
      childCount,
    });
    if (!expanded || children === undefined) return;
    for (const child of children) {
      const childId = childNodeId(id, child.name);
      const isSchema = child.kind === 'schema';
      push(
        childId,
        depth + 1,
        child.kind,
        child.name,
        isSchema ? '' : child.schema,
        connectionId,
        child.oid,
        child.comment,
        child.rowEstimate,
        child.hasChildren,
      );
    }
  };

  for (const root of input.roots) {
    push(root.id, 0, 'connection', root.label, '', root.connectionId, 0, null, -1, root.expandable);
  }
  return rows;
}

export interface VirtualWindow {
  /** First rendered row index, inclusive. */
  readonly start: number;
  /** Last rendered row index, exclusive. */
  readonly end: number;
  /** `start * rowHeight` — the transform the rendered slice sits at. */
  readonly offsetY: number;
  /** `totalRows * rowHeight` — the spacer height that makes the scrollbar honest. */
  readonly contentHeight: number;
  readonly rendered: number;
}

export interface VirtualWindowParams {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly totalRows: number;
  readonly overscan?: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Which rows to render for a scroll offset. **O(1)** — no loop over rows, no
 * allocation proportional to the tree.
 *
 * Degenerate inputs degrade rather than throw. This runs inside a scroll handler:
 * a throw would take the whole pane down, and a zero-height viewport is a real
 * transient during window resize. A non-positive or non-finite `rowHeight` falls
 * back to the default so `contentHeight` — and therefore the scrollbar — stays
 * consistent with what the component actually laid out.
 */
export function virtualWindow(params: VirtualWindowParams): VirtualWindow {
  const rowHeight =
    Number.isFinite(params.rowHeight) && params.rowHeight > 0
      ? params.rowHeight
      : DEFAULT_ROW_HEIGHT;
  const viewportHeight =
    Number.isFinite(params.viewportHeight) && params.viewportHeight > 0 ? params.viewportHeight : 0;
  // An omitted overscan means "the default", not "none" — the two behave very
  // differently under a fast flick, and the component should not have to repeat the
  // constant at every call site.
  const requestedOverscan = params.overscan ?? DEFAULT_OVERSCAN;
  const overscan =
    Number.isFinite(requestedOverscan) && requestedOverscan > 0 ? Math.floor(requestedOverscan) : 0;
  const totalRows = Number.isFinite(params.totalRows)
    ? Math.max(0, Math.trunc(params.totalRows))
    : 0;

  const contentHeight = totalRows * rowHeight;
  if (totalRows === 0) {
    return { start: 0, end: 0, offsetY: 0, contentHeight: 0, rendered: 0 };
  }

  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const scrollTop = Number.isFinite(params.scrollTop)
    ? clamp(params.scrollTop as number, 0, maxScroll)
    : 0;

  const first = Math.min(totalRows - 1, Math.floor(scrollTop / rowHeight));
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(totalRows, first + visibleCount + overscan);

  return { start, end, offsetY: start * rowHeight, contentHeight, rendered: end - start };
}

/**
 * Case-insensitive substring match against the label and, for a relation, the
 * schema-qualified name — because that is how people type tables.
 *
 * A blank query never matches; {@link filterRows} handles it separately so that
 * clearing the box is not "match everything and rebuild the list".
 */
export function matchesQuery(row: TreeRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return false;
  if (row.label.toLowerCase().includes(needle)) return true;
  if (row.schema === '') return false;
  return `${row.schema}.${row.label}`.toLowerCase().includes(needle);
}

/**
 * The rows a filter leaves visible: every match, plus every ancestor of a match.
 *
 * One forward pass over the pre-order list with a stack of the currently open
 * ancestors. A row is kept when it matches **or** when any descendant does, and
 * descendants are only known after the row opens — so each row is pushed with its
 * own match, ORed into by its children as they close, and written to `keep` when
 * the pass leaves its subtree. O(rows), O(depth) stack.
 *
 * A reverse pass looks tempting and is wrong: a kept row separated from its
 * ancestor by a non-matching sibling gets lost, because the sibling overwrites the
 * running flag before the ancestor reads it.
 *
 * Returns the **same array instance** for a blank query. That is not a
 * micro-optimisation: it keeps the caller's `computed` from producing a new
 * reference on every keystroke of an empty box, which would re-render 2,000 rows
 * for nothing.
 *
 * Only loaded rows can match. A collapsed, never-expanded schema is invisible to
 * the filter, and the pane says so rather than pretending the tree was searched.
 */
export function filterRows(rows: readonly TreeRow[], query: string): readonly TreeRow[] {
  if (query.trim() === '') return rows;

  const total = rows.length;
  const keep = new Array<boolean>(total).fill(false);
  const open: { index: number; kept: boolean }[] = [];

  const close = (): void => {
    const closed = open.pop();
    if (closed === undefined) return;
    const parent = open[open.length - 1];
    if (parent !== undefined && closed.kept) parent.kept = true;
    keep[closed.index] = closed.kept;
  };

  for (let i = 0; i < total; i += 1) {
    const row = rows[i] as TreeRow;
    // A row deeper than the stack is open for cannot exist in a pre-order list, but
    // clamping costs nothing and turns a malformed input into a flat result instead
    // of a silently wrong one.
    const depth = Math.min(row.depth, open.length);
    while (open.length > depth) close();
    open.push({ index: i, kept: matchesQuery(row, query) });
  }
  while (open.length > 0) close();

  const filtered: TreeRow[] = [];
  for (let i = 0; i < total; i += 1) {
    if (keep[i] === true) filtered.push(rows[i] as TreeRow);
  }
  return filtered;
}

/** Index of a row by id, or -1. */
export function indexOfId(rows: readonly TreeRow[], id: string): number {
  for (let i = 0; i < rows.length; i += 1) {
    if ((rows[i] as TreeRow).id === id) return i;
  }
  return -1;
}

/** Index of the row that contains `index`, or -1 for a root or a bad index. */
export function parentIndexOf(rows: readonly TreeRow[], index: number): number {
  if (index < 1 || index >= rows.length) return -1;
  const depth = (rows[index] as TreeRow).depth;
  for (let i = index - 1; i >= 0; i -= 1) {
    if ((rows[i] as TreeRow).depth === depth - 1) return i;
  }
  return -1;
}

/** Exclusive end of the subtree rooted at `index`, or -1 for a bad index. */
export function subtreeEnd(rows: readonly TreeRow[], index: number): number {
  if (index < 0 || index >= rows.length) return -1;
  const depth = (rows[index] as TreeRow).depth;
  let i = index + 1;
  while (i < rows.length && (rows[i] as TreeRow).depth > depth) i += 1;
  return i;
}

export type TreeKeyAction =
  | { readonly type: 'none' }
  | { readonly type: 'select'; readonly id: string }
  | { readonly type: 'toggle'; readonly id: string; readonly expand: boolean }
  /** A leaf was activated: open the relation. The caller decides what that means. */
  | { readonly type: 'activate'; readonly id: string };

export interface KeyActionOptions {
  /** Rows moved by PageUp/PageDown. The component passes its viewport height in rows. */
  readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * The ARIA treeview keyboard contract, as a pure transition.
 *
 * Returns an *action* rather than mutating anything, so the component stays the
 * only place that touches state — and so these transitions are testable without a
 * DOM. Keys the tree does not own return `none` and must not be prevented, or the
 * pane would swallow Tab and steal focus from the rest of the app.
 *
 * ArrowRight/ArrowLeft follow the WAI-ARIA pattern rather than the file-manager
 * one: Right expands a closed node without moving the selection, and only descends
 * when the node is already open. Left collapses an open node before it retreats to
 * the parent, so one key never does two surprising things.
 */
export function keyAction(
  rows: readonly TreeRow[],
  selectedId: string | null,
  key: string,
  options: KeyActionOptions = {},
): TreeKeyAction {
  const total = rows.length;
  if (total === 0) return { type: 'none' };

  const current = selectedId === null ? -1 : indexOfId(rows, selectedId);

  const select = (index: number): TreeKeyAction => {
    if (index < 0 || index >= total) return { type: 'none' };
    const row = rows[index] as TreeRow;
    // Selecting the row already selected is not an action: returning one would
    // make the component scroll and re-render on a keypress that changed nothing.
    return index === current ? { type: 'none' } : { type: 'select', id: row.id };
  };

  if (current < 0) {
    // A stale id — the tree was refreshed underneath — behaves as no selection.
    return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home'
      ? select(0)
      : key === 'End'
        ? select(total - 1)
        : { type: 'none' };
  }

  const row = rows[current] as TreeRow;

  switch (key) {
    case 'ArrowDown':
      return select(current + 1);
    case 'ArrowUp':
      return select(current - 1);
    case 'Home':
      return select(0);
    case 'End':
      return select(total - 1);
    case 'PageDown':
    case 'PageUp': {
      const pageSize =
        Number.isFinite(options.pageSize) && (options.pageSize as number) > 0
          ? Math.floor(options.pageSize as number)
          : DEFAULT_PAGE_SIZE;
      return select(current + (key === 'PageDown' ? pageSize : -pageSize));
    }
    case 'ArrowRight':
      if (!row.expandable) return { type: 'none' };
      if (!row.expanded) return { type: 'toggle', id: row.id, expand: true };
      return select(current + 1);
    case 'ArrowLeft':
      if (row.expandable && row.expanded) return { type: 'toggle', id: row.id, expand: false };
      return select(parentIndexOf(rows, current));
    case 'Enter':
      if (row.expandable) return { type: 'toggle', id: row.id, expand: !row.expanded };
      return { type: 'activate', id: row.id };
    default:
      return { type: 'none' };
  }
}

/**
 * The scroll offset that brings `index` into view, or null when it already is.
 *
 * Mirrors `ScrollController.scrollToRow`'s `nearest` alignment: no movement is the
 * right answer for a row the user can already see, and a keyboard walk down a long
 * schema should not jitter the viewport on every keypress.
 */
export function scrollOffsetForIndex(
  index: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  totalRows: number,
): number | null {
  if (index < 0 || index >= totalRows) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return null;
}
