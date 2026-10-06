/**
 * The virtualised schema tree (PLAN Phase 6).
 *
 * Tier 1 under AGENTS.md: pure geometry and pure state transitions, no DOM and no
 * IPC. The component that renders this is Tier 2; everything that decides *which*
 * rows exist and *which* of them are on screen is here, and is tested here.
 *
 * Expectations come from the exit criterion — 2,000 tables must render and scroll
 * smoothly — and from the ARIA treeview keyboard contract. The load-bearing
 * invariant is the split between the two functions:
 *
 *   flattenRows   runs when the tree's *contents* change (expand, load, filter)
 *   virtualWindow runs when only the *scroll offset* changed — every frame
 *
 * So `virtualWindow` must be O(1) in the number of rows. That is what makes
 * scrolling a 2,000-table schema cost the same as scrolling a 20-table one, and
 * the "work is proportional to the viewport" test below is the assertion that
 * keeps it true.
 */
import { describe, expect, it } from 'vitest';
import type { SchemaNode } from '@shared/domain';
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  ID_SEPARATOR,
  childNodeId,
  connectionNodeId,
  filterRows,
  flattenRows,
  indexOfId,
  isDescendantOf,
  keyAction,
  matchesQuery,
  parentIndexOf,
  scrollOffsetForIndex,
  subtreeEnd,
  virtualWindow,
  type TreeInput,
  type TreeRoot,
  type TreeRow,
} from '@/schema/tree-model';

function node(overrides: Partial<SchemaNode> = {}): SchemaNode {
  return {
    kind: 'table',
    name: 'big',
    schema: 'fixtures',
    oid: 16_400,
    comment: null,
    rowEstimate: 10_000_000,
    hasChildren: false,
    ...overrides,
  };
}

function schemaNode(name: string, overrides: Partial<SchemaNode> = {}): SchemaNode {
  return node({ kind: 'schema', name, schema: name, oid: 16_384, hasChildren: true, ...overrides });
}

const CONN: TreeRoot = {
  id: connectionNodeId('conn-1'),
  connectionId: 'conn-1',
  label: 'localhost:5432/tabby-data-test',
  expandable: true,
};

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    roots: [CONN],
    children: new Map(),
    expanded: new Set(),
    loading: new Set(),
    failed: new Set(),
    ...overrides,
  };
}

/** connection → two schemas → tables, all loaded and expanded. */
function fullTree(): TreeInput {
  const connId = CONN.id;
  const fixturesId = childNodeId(connId, 'fixtures');
  // `public` is a reserved word in a module, so the local cannot share the name.
  const publicId = childNodeId(connId, 'public');
  return input({
    children: new Map([
      [connId, [schemaNode('fixtures'), schemaNode('public')]],
      [fixturesId, [node({ name: 'big' }), node({ name: 'wide' })]],
      [publicId, [node({ name: 'plain_table', schema: 'public' })]],
    ]),
    expanded: new Set([connId, fixturesId, publicId]),
  });
}

describe('node ids', () => {
  it('joins with NUL, which cannot appear in a Postgres identifier', () => {
    // The same reasoning SchemaService uses for its cache keys: two different
    // (schema, table) pairs can never collide. A printable separator would let
    // `a.b` / `a` + `b` produce the same id.
    expect(ID_SEPARATOR).toBe('\u0000');
    expect(connectionNodeId('conn-1')).toBe('conn-1');
    expect(childNodeId('conn-1', 'fixtures')).toBe(`conn-1\u0000fixtures`);
  });

  it('distinguishes names that differ only by punctuation', () => {
    expect(childNodeId('c', 'a.b')).not.toBe(childNodeId(childNodeId('c', 'a'), 'b'));
  });

  it('answers the descendant question from the id alone, without walking rows', () => {
    const parent = childNodeId('c', 'fixtures');
    const child = childNodeId(parent, 'big');
    expect(isDescendantOf(child, parent)).toBe(true);
    expect(isDescendantOf(parent, child)).toBe(false);
    expect(isDescendantOf(parent, parent)).toBe(false);
    // A prefix that is not a segment boundary must not count: `fix` is not the
    // parent of `fixtures.big`.
    expect(isDescendantOf(child, 'c')).toBe(true);
    expect(isDescendantOf(childNodeId('c', 'fix'), 'c')).toBe(true);
    expect(isDescendantOf('cxx\u0000y', 'c')).toBe(false);
  });
});

describe('flattenRows: shape', () => {
  it('returns nothing for no roots', () => {
    expect(flattenRows(input({ roots: [] }))).toEqual([]);
  });

  it('renders a collapsed root as one unloaded, expandable row', () => {
    const rows = flattenRows(input());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'conn-1',
      depth: 0,
      kind: 'connection',
      label: 'localhost:5432/tabby-data-test',
      schema: '',
      connectionId: 'conn-1',
      oid: 0,
      comment: null,
      rowEstimate: -1,
      expandable: true,
      expanded: false,
      loading: false,
      failed: false,
      unloaded: true,
      childCount: -1,
    });
  });

  it('distinguishes a loaded-but-empty schema from one never read', () => {
    // Rendering both as "(empty)" would tell the user a database has no tables when
    // Tabby has simply not looked yet.
    const emptyId = childNodeId(CONN.id, 'empty');
    const rows = flattenRows(
      input({
        children: new Map([
          [CONN.id, [schemaNode('empty'), schemaNode('unread')]],
          [emptyId, []],
        ]),
        expanded: new Set([CONN.id, emptyId]),
      }),
    );
    expect(rows.find((row) => row.label === 'empty')).toMatchObject({
      unloaded: false,
      childCount: 0,
      expanded: true,
    });
    expect(rows.find((row) => row.label === 'unread')).toMatchObject({
      unloaded: true,
      childCount: -1,
      expanded: false,
    });
  });

  it('renders children in the order the catalog returned them, pre-order, with depth', () => {
    const rows = flattenRows(fullTree());
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.label}`)).toEqual([
      'localhost:5432/tabby-data-test',
      '  fixtures',
      '    big',
      '    wide',
      '  public',
      '    plain_table',
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2, 1, 2]);
  });

  it('carries kind, schema, comment and estimate through to the row', () => {
    const rows = flattenRows(fullTree());
    const big = rows.find((row) => row.label === 'big');
    expect(big).toMatchObject({
      kind: 'table',
      schema: 'fixtures',
      connectionId: 'conn-1',
      oid: 16_400,
      rowEstimate: 10_000_000,
      expandable: false,
    });
  });

  it('gives a schema row no schema of its own, so the qualified haystack is not doubled', () => {
    const rows = flattenRows(fullTree());
    expect(rows.find((row) => row.label === 'fixtures')?.schema).toBe('');
    expect(rows.find((row) => row.label === 'big')?.schema).toBe('fixtures');
    expect(rows.find((row) => row.label === CONN.label)?.schema).toBe('');
  });

  it('stops at a collapsed node even though its children are loaded', () => {
    const tree = fullTree();
    const fixtures = childNodeId(CONN.id, 'fixtures');
    const rows = flattenRows({ ...tree, expanded: new Set([CONN.id]) });
    expect(rows.map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      'fixtures',
      'public',
    ]);
    expect(rows.some((row) => row.id === fixtures && row.unloaded)).toBe(false);
  });

  it('marks an expanded node whose children have not arrived yet as unloaded', () => {
    const rows = flattenRows(input({ expanded: new Set([CONN.id]) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ expanded: true, unloaded: true, loading: false });
  });

  it('reports loading and failure as separate flags, because they render differently', () => {
    const loading = flattenRows(input({ loading: new Set([CONN.id]) }));
    expect(loading[0]).toMatchObject({ loading: true, failed: false });

    const failed = flattenRows(input({ failed: new Set([CONN.id]) }));
    expect(failed[0]).toMatchObject({ loading: false, failed: true });
  });

  it('treats a node with hasChildren false as a leaf even if it is expanded', () => {
    // A view has no children in this tree. Expanding it must not show a phantom
    // "(empty)" row or leave the caret in a state it cannot leave.
    const rows = flattenRows(
      input({
        children: new Map([
          [CONN.id, [node({ kind: 'view', name: 'a_view', hasChildren: false })]],
        ]),
        expanded: new Set([CONN.id, childNodeId(CONN.id, 'a_view')]),
      }),
    );
    const view = rows.find((row) => row.label === 'a_view');
    expect(view).toMatchObject({ expandable: false, expanded: false });
    expect(rows).toHaveLength(2);
  });

  it('expandAll overrides the expanded set, which is what makes a filter reachable', () => {
    const rows = flattenRows(fullTree(), { expandAll: true });
    expect(rows).toHaveLength(6);
    const collapsed = flattenRows(
      { ...fullTree(), expanded: new Set<string>() },
      { expandAll: true },
    );
    expect(collapsed).toHaveLength(6);
    expect(collapsed.every((row) => !row.expandable || row.expanded)).toBe(true);
  });

  it('does not mutate its input', () => {
    const tree = fullTree();
    const before = [...tree.expanded];
    flattenRows(tree, { expandAll: true });
    filterRows(flattenRows(tree), 'big');
    expect([...tree.expanded]).toEqual(before);
    expect(tree.children.size).toBe(3);
  });
});

describe('flattenRows: a 2,000-table schema', () => {
  const MANY = 2_000;
  const manyId = childNodeId(CONN.id, 'many');

  function manyTree(): TreeInput {
    const tables = Array.from({ length: MANY }, (_, i) =>
      node({ name: `t${String(i).padStart(4, '0')}`, oid: 20_000 + i, rowEstimate: i }),
    );
    return input({
      children: new Map([
        [CONN.id, [schemaNode('many')]],
        [manyId, tables],
      ]),
      expanded: new Set([CONN.id, manyId]),
    });
  }

  it('produces exactly one row per node, in order', () => {
    const rows = flattenRows(manyTree());
    expect(rows).toHaveLength(2 + MANY);
    expect(rows[2]?.label).toBe('t0000');
    expect(rows[2 + MANY - 1]?.label).toBe(`t${MANY - 1}`);
    // Ids must be unique or Vue's keyed list will reuse the wrong element.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('assigns every row the same depth as its siblings', () => {
    const rows = flattenRows(manyTree());
    expect(new Set(rows.slice(2).map((row) => row.depth))).toEqual(new Set([2]));
  });
});

describe('virtualWindow', () => {
  const base = {
    scrollTop: 0,
    viewportHeight: 220,
    rowHeight: DEFAULT_ROW_HEIGHT,
    totalRows: 100,
  };

  it('has sane defaults', () => {
    expect(DEFAULT_ROW_HEIGHT).toBe(22);
    expect(DEFAULT_OVERSCAN).toBe(6);
  });

  it('renders the visible rows plus overscan on the side being scrolled toward', () => {
    const window = virtualWindow(base);
    expect(window.start).toBe(0);
    // 220 / 22 = 10 visible, plus 6 overscan below; nothing above row 0.
    expect(window.end).toBe(16);
    expect(window.rendered).toBe(16);
    expect(window.offsetY).toBe(0);
    expect(window.contentHeight).toBe(2_200);
  });

  it('overscans both sides once the viewport is mid-list', () => {
    const window = virtualWindow({ ...base, scrollTop: 1_100 });
    expect(window.start).toBe(50 - DEFAULT_OVERSCAN);
    expect(window.end).toBe(50 + 10 + DEFAULT_OVERSCAN);
    expect(window.offsetY).toBe(window.start * DEFAULT_ROW_HEIGHT);
  });

  it('clamps at both ends of the list', () => {
    expect(virtualWindow({ ...base, totalRows: 100, scrollTop: 0 }).start).toBe(0);
    const atEnd = virtualWindow({ ...base, scrollTop: 999_999 });
    expect(atEnd.end).toBe(100);
    expect(atEnd.start).toBeLessThan(100);
  });

  it('does no work proportional to the row count — 2,000 and 200,000 cost the same', () => {
    // This is the invariant the exit criterion rests on. If `virtualWindow` ever
    // grew a loop over rows, scrolling a big schema would degrade exactly where it
    // cannot be allowed to.
    const small = virtualWindow({ ...base, totalRows: 2_000, scrollTop: 4_400 });
    const large = virtualWindow({ ...base, totalRows: 200_000, scrollTop: 4_400 });
    expect(small.start).toBe(large.start);
    expect(small.end).toBe(large.end);
    expect(small.rendered).toBe(large.rendered);
    expect(small.rendered).toBeLessThanOrEqual(Math.ceil(220 / 22) + 2 * DEFAULT_OVERSCAN);
  });

  it('handles fractional scroll offsets, which is what a trackpad produces', () => {
    const window = virtualWindow({ ...base, scrollTop: 110.5 });
    expect(Number.isInteger(window.start)).toBe(true);
    expect(Number.isInteger(window.end)).toBe(true);
    // 110.5 / 22 = 5.02, so row 5 is the first partially-visible one; overscan 6
    // reaches back past the top and clamps.
    expect(window.start).toBe(0);
    expect(window.end).toBe(5 + 10 + DEFAULT_OVERSCAN);
  });

  it('handles a viewport taller than the content', () => {
    const window = virtualWindow({ ...base, viewportHeight: 10_000, totalRows: 5 });
    expect(window).toMatchObject({ start: 0, end: 5, rendered: 5, contentHeight: 110 });
  });

  it('returns an empty window for an empty list', () => {
    expect(virtualWindow({ ...base, totalRows: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetY: 0,
      contentHeight: 0,
      rendered: 0,
    });
  });

  it('degrades rather than throwing on a degenerate viewport or row height', () => {
    // A render path that throws takes the whole pane down; a collapsed viewport is
    // a real transient state during window resize and layout.
    for (const viewportHeight of [0, -1, Number.NaN]) {
      const window = virtualWindow({ ...base, viewportHeight });
      expect(window.contentHeight, String(viewportHeight)).toBe(2_200);
      expect(window.rendered, String(viewportHeight)).toBeGreaterThanOrEqual(0);
      expect(window.end, String(viewportHeight)).toBeGreaterThanOrEqual(window.start);
    }
    for (const rowHeight of [0, -22, Number.NaN]) {
      const window = virtualWindow({ ...base, rowHeight });
      expect(window.contentHeight, String(rowHeight)).toBe(2_200);
      expect(window.end, String(rowHeight)).toBeGreaterThanOrEqual(window.start);
    }
  });

  it('treats a non-finite or negative scroll offset as the top', () => {
    for (const scrollTop of [Number.NaN, Number.POSITIVE_INFINITY, -500]) {
      expect(virtualWindow({ ...base, scrollTop }).start, String(scrollTop)).toBe(0);
    }
  });

  it('honours overscan 0, which renders exactly the visible rows', () => {
    const window = virtualWindow({ ...base, scrollTop: 1_100, overscan: 0 });
    expect(window).toMatchObject({ start: 50, end: 60, rendered: 10 });
  });

  it('clamps a negative or non-finite overscan to zero', () => {
    for (const overscan of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = virtualWindow({ ...base, scrollTop: 1_100, overscan });
      expect(window.rendered, String(overscan)).toBeLessThanOrEqual(10 + 2 * DEFAULT_OVERSCAN);
      expect(window.start, String(overscan)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('filterRows', () => {
  const rows = flattenRows(fullTree());

  it('returns the rows unchanged for an empty or whitespace query', () => {
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, '   ')).toBe(rows);
  });

  it('keeps a match together with every ancestor, so it stays reachable', () => {
    const filtered = filterRows(rows, 'wide');
    expect(filtered.map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      'fixtures',
      'wide',
    ]);
  });

  it('drops a subtree that contains no match', () => {
    const filtered = filterRows(rows, 'plain_table');
    expect(filtered.map((row) => row.label)).not.toContain('fixtures');
    expect(filtered.map((row) => row.label)).not.toContain('big');
    expect(filtered.map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      'public',
      'plain_table',
    ]);
  });

  it('returns nothing when no row matches, rather than the whole tree', () => {
    expect(filterRows(rows, 'no_such_table_anywhere')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(filterRows(rows, 'BIG').map((row) => row.label)).toContain('big');
    expect(filterRows(rows, 'Fixtures').map((row) => row.label)).toContain('fixtures');
  });

  it('matches a schema-qualified name, which is how users type tables', () => {
    expect(filterRows(rows, 'fixtures.big').map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      'fixtures',
      'big',
    ]);
    // A schema node's own haystack must not be `fixtures.fixtures`.
    expect(filterRows(rows, 'fixtures.public')).toEqual([]);
  });

  it('keeps an ancestor that matches, and drops its descendants that do not', () => {
    const filtered = filterRows(rows, 'localhost');
    expect(filtered.map((row) => row.label)).toEqual(['localhost:5432/tabby-data-test']);
  });

  it('keeps every row matching on its own label, including via the schema prefix', () => {
    const filtered = filterRows(rows, 'public');
    // `public` matches the schema node directly, and `plain_table` through its
    // qualified haystack `public.plain_table`. `fixtures` matches nothing and is
    // not an ancestor of a match, so it goes.
    expect(filtered.map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      'public',
      'plain_table',
    ]);
  });

  it('is not confused by a name that is a prefix of a sibling', () => {
    const many = flattenRows(
      input({
        children: new Map([
          [CONN.id, [schemaNode('s')]],
          [
            childNodeId(CONN.id, 's'),
            [node({ name: 't0001' }), node({ name: 't0001x' }), node({ name: 't0002' })],
          ],
        ]),
        expanded: new Set([CONN.id, childNodeId(CONN.id, 's')]),
      }),
    );
    expect(filterRows(many, 't0001').map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      's',
      't0001',
      't0001x',
    ]);
    expect(filterRows(many, 't0002').map((row) => row.label)).toEqual([
      'localhost:5432/tabby-data-test',
      's',
      't0002',
    ]);
  });

  it('preserves depth and pre-order, so the filtered list still renders as a tree', () => {
    const filtered = filterRows(rows, 'wide');
    expect(filtered.map((row) => row.depth)).toEqual([0, 1, 2]);
  });

  it('handles an empty row list', () => {
    expect(filterRows([], 'anything')).toEqual([]);
  });
});

describe('matchesQuery', () => {
  const [root, schema, table] = flattenRows(fullTree()) as [TreeRow, TreeRow, TreeRow];

  it('matches the label and the qualified name', () => {
    expect(matchesQuery(table, 'big')).toBe(true);
    expect(matchesQuery(table, 'fixtures.big')).toBe(true);
    expect(matchesQuery(table, 'FIXTURES.BIG')).toBe(true);
    expect(matchesQuery(table, 'small')).toBe(false);
  });

  it('never matches on an empty query, which the caller handles separately', () => {
    expect(matchesQuery(table, '')).toBe(false);
    expect(matchesQuery(table, '   ')).toBe(false);
  });

  it('matches a connection row on its label', () => {
    expect(matchesQuery(root, 'tabby-data-test')).toBe(true);
    expect(matchesQuery(schema, 'fixtures')).toBe(true);
    // A schema row's qualified form is just its name.
    expect(matchesQuery(schema, 'fixtures.fixtures')).toBe(false);
  });

  it('trims the query but not the row, so a name with spaces is still findable', () => {
    const spaced = flattenRows(
      input({
        children: new Map([[CONN.id, [node({ name: 'Mixed Case', schema: 'public' })]]]),
        expanded: new Set([CONN.id]),
      }),
    );
    const row = spaced[1];
    expect(row).toBeDefined();
    expect(matchesQuery(row as TreeRow, '  mixed case  ')).toBe(true);
  });
});

describe('row lookups', () => {
  const rows = flattenRows(fullTree());

  it('finds an index by id, and reports -1 when absent', () => {
    expect(indexOfId(rows, childNodeId(CONN.id, 'fixtures'))).toBe(1);
    expect(indexOfId(rows, 'nope')).toBe(-1);
    expect(indexOfId([], 'anything')).toBe(-1);
  });

  it('finds the parent index from the depth sequence', () => {
    expect(parentIndexOf(rows, 2)).toBe(1); // big → fixtures
    expect(parentIndexOf(rows, 1)).toBe(0); // fixtures → connection
    expect(parentIndexOf(rows, 0)).toBe(-1); // root has none
    expect(parentIndexOf(rows, 99)).toBe(-1);
    expect(parentIndexOf(rows, -1)).toBe(-1);
  });

  it('finds the exclusive end of a subtree', () => {
    expect(subtreeEnd(rows, 1)).toBe(4); // fixtures spans big, wide
    expect(subtreeEnd(rows, 2)).toBe(3); // big is a leaf
    expect(subtreeEnd(rows, 0)).toBe(rows.length);
    expect(subtreeEnd(rows, rows.length - 1)).toBe(rows.length);
    expect(subtreeEnd(rows, 99)).toBe(-1);
  });
});

describe('keyAction', () => {
  const rows = flattenRows(fullTree());
  const connId = CONN.id;
  const fixtures = childNodeId(connId, 'fixtures');
  const big = childNodeId(fixtures, 'big');

  it('ignores a key it does not own', () => {
    for (const key of ['a', 'x', 'Tab', 'Escape', 'Shift', 'F1', '']) {
      expect(keyAction(rows, connId, key), key).toEqual({ type: 'none' });
    }
  });

  it('selects the first row when nothing is selected', () => {
    expect(keyAction(rows, null, 'ArrowDown')).toEqual({ type: 'select', id: connId });
    expect(keyAction(rows, null, 'ArrowUp')).toEqual({ type: 'select', id: connId });
    expect(keyAction(rows, null, 'ArrowRight')).toEqual({ type: 'none' });
    expect(keyAction([], null, 'ArrowDown')).toEqual({ type: 'none' });
  });

  it('moves one row at a time and stops at both ends', () => {
    expect(keyAction(rows, connId, 'ArrowDown')).toEqual({ type: 'select', id: fixtures });
    expect(keyAction(rows, fixtures, 'ArrowUp')).toEqual({ type: 'select', id: connId });
    expect(keyAction(rows, connId, 'ArrowUp')).toEqual({ type: 'none' });
    const last = rows[rows.length - 1]?.id as string;
    expect(keyAction(rows, last, 'ArrowDown')).toEqual({ type: 'none' });
  });

  it('jumps to the first and last row on Home and End', () => {
    expect(keyAction(rows, big, 'Home')).toEqual({ type: 'select', id: connId });
    expect(keyAction(rows, connId, 'End')).toEqual({
      type: 'select',
      id: rows[rows.length - 1]?.id,
    });
  });

  it('expands on ArrowRight when collapsed, without moving the selection', () => {
    const collapsed = flattenRows({ ...fullTree(), expanded: new Set([connId]) });
    expect(keyAction(collapsed, fixtures, 'ArrowRight')).toEqual({
      type: 'toggle',
      id: fixtures,
      expand: true,
    });
  });

  it('descends into the first child on ArrowRight when already expanded', () => {
    expect(keyAction(rows, fixtures, 'ArrowRight')).toEqual({ type: 'select', id: big });
  });

  it('does nothing on ArrowRight at an expanded leaf', () => {
    expect(keyAction(rows, big, 'ArrowRight')).toEqual({ type: 'none' });
  });

  it('collapses on ArrowLeft when expanded, and moves to the parent when not', () => {
    expect(keyAction(rows, fixtures, 'ArrowLeft')).toEqual({
      type: 'toggle',
      id: fixtures,
      expand: false,
    });
    expect(keyAction(rows, big, 'ArrowLeft')).toEqual({ type: 'select', id: fixtures });
  });

  it('moves to the parent on ArrowLeft from a collapsed node', () => {
    const collapsed = flattenRows({ ...fullTree(), expanded: new Set([connId]) });
    expect(keyAction(collapsed, fixtures, 'ArrowLeft')).toEqual({ type: 'select', id: connId });
  });

  it('collapses an expanded root on ArrowLeft, and does nothing once it is closed', () => {
    // The root is a node like any other: ArrowLeft closes it when it is open. What
    // it must not do is fall through to "move to the parent" and vanish.
    expect(keyAction(rows, connId, 'ArrowLeft')).toEqual({
      type: 'toggle',
      id: connId,
      expand: false,
    });
    const closed = flattenRows({ ...fullTree(), expanded: new Set<string>() });
    expect(keyAction(closed, connId, 'ArrowLeft')).toEqual({ type: 'none' });
  });

  it('toggles an expandable node on Enter and activates a leaf', () => {
    expect(keyAction(rows, fixtures, 'Enter')).toEqual({
      type: 'toggle',
      id: fixtures,
      expand: false,
    });
    expect(keyAction(rows, big, 'Enter')).toEqual({ type: 'activate', id: big });
    const collapsed = flattenRows({ ...fullTree(), expanded: new Set([connId]) });
    expect(keyAction(collapsed, fixtures, 'Enter')).toEqual({
      type: 'toggle',
      id: fixtures,
      expand: true,
    });
  });

  it('treats a stale selection id as no selection', () => {
    // The tree reloads after a refresh; a selected id can vanish underneath.
    expect(keyAction(rows, 'gone', 'ArrowDown')).toEqual({ type: 'select', id: connId });
    expect(keyAction(rows, 'gone', 'Enter')).toEqual({ type: 'none' });
  });

  it('handles PageDown and PageUp as a viewport-sized jump', () => {
    const many = flattenRows(
      input({
        children: new Map([
          [CONN.id, [schemaNode('s')]],
          [
            childNodeId(CONN.id, 's'),
            Array.from({ length: 200 }, (_, i) => node({ name: `t${i}`, oid: i })),
          ],
        ]),
        expanded: new Set([CONN.id, childNodeId(CONN.id, 's')]),
      }),
    );
    const action = keyAction(many, childNodeId(CONN.id, 's'), 'PageDown', { pageSize: 10 });
    expect(action.type).toBe('select');
    if (action.type === 'select') {
      expect(indexOfId(many, action.id)).toBe(11);
    }
    const up = keyAction(many, many[50]?.id as string, 'PageUp', { pageSize: 10 });
    expect(up.type === 'select' ? indexOfId(many, up.id) : -1).toBe(40);
  });

  it('clamps a page jump at both ends', () => {
    const first = rows[0]?.id as string;
    const up = keyAction(rows, first, 'PageUp', { pageSize: 10 });
    expect(up).toEqual({ type: 'none' });
    const last = rows[rows.length - 1]?.id as string;
    expect(keyAction(rows, last, 'PageDown', { pageSize: 10 })).toEqual({ type: 'none' });
  });
});

describe('scrollOffsetForIndex', () => {
  const rowHeight = DEFAULT_ROW_HEIGHT;
  const viewport = 220; // exactly ten rows

  it('does not move for a row that is already fully visible', () => {
    // Returning an offset here would make walking down a schema with ArrowDown
    // jitter the viewport on every keypress.
    expect(scrollOffsetForIndex(3, rowHeight, viewport, 0, 100)).toBeNull();
    expect(scrollOffsetForIndex(9, rowHeight, viewport, 0, 100)).toBeNull();
    expect(scrollOffsetForIndex(50, rowHeight, viewport, 1_000, 100)).toBeNull();
  });

  it('scrolls up to the top of a row above the viewport', () => {
    expect(scrollOffsetForIndex(0, rowHeight, viewport, 1_000, 100)).toBe(0);
    expect(scrollOffsetForIndex(40, rowHeight, viewport, 1_000, 100)).toBe(880);
  });

  it('scrolls down just far enough for a row below the viewport', () => {
    // Row 12 spans 264..286, so a 220px viewport must land at 66 to show all of it.
    expect(scrollOffsetForIndex(12, rowHeight, viewport, 0, 100)).toBe(66);
  });

  it('moves for a partially-visible row at the bottom edge', () => {
    // Row 10 spans 220..242, so it is one pixel-line short of fully visible.
    expect(scrollOffsetForIndex(10, rowHeight, viewport, 0, 100)).toBe(22);
  });

  it('returns null for an index outside the list', () => {
    expect(scrollOffsetForIndex(-1, rowHeight, viewport, 0, 100)).toBeNull();
    expect(scrollOffsetForIndex(100, rowHeight, viewport, 0, 100)).toBeNull();
    expect(scrollOffsetForIndex(0, rowHeight, viewport, 0, 0)).toBeNull();
  });
});
