// @vitest-environment happy-dom
/**
 * The schema tree component (PLAN Phase 6).
 *
 * Tier 2 under AGENTS.md — Vue plus DOM — so these are written after the
 * implementation. The logic worth proving is in `schema-tree-model.spec.ts` and
 * `schema-store.spec.ts`; what only a mounted component can show is that the
 * virtualisation is actually happening:
 *
 *  - a 2,000-relation schema puts **sixteen** rows in the DOM and a 44,000px
 *    spacer in the scroller, not 2,000 elements;
 *  - scrolling swaps which sixteen, without the count changing;
 *  - `aria-setsize`/`aria-posinset` still describe the whole tree, so an assistive
 *    technology is not told the database has sixteen tables;
 *  - the keyboard contract reaches the store and the `open` intent reaches the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { SchemaNode } from '@shared/domain';
import SchemaTree from '@/components/SchemaTree.vue';
import { useSchemaStore } from '@/stores/schema';
import { childNodeId, connectionNodeId, DEFAULT_OVERSCAN } from '@/schema/tree-model';

const MANY = 2_000;
const VIEWPORT = 220; // ten 22px rows
const CONN = 'conn-1';
const ROOT = connectionNodeId(CONN);
const MANY_ID = childNodeId(ROOT, 'many');

function node(overrides: Partial<SchemaNode> = {}): SchemaNode {
  return {
    kind: 'table',
    name: 'big',
    schema: 'fixtures',
    oid: 1,
    comment: null,
    rowEstimate: -1,
    hasChildren: false,
    ...overrides,
  };
}

function schemaNode(name: string): SchemaNode {
  return node({ kind: 'schema', name, schema: name, hasChildren: true });
}

interface Stub {
  readonly childrenCalls: (string | null)[];
  readonly refreshCalls: string[];
  writeText: ReturnType<typeof vi.fn>;
}

function stubBridge(): Stub {
  const stub: Stub = {
    childrenCalls: [],
    refreshCalls: [],
    writeText: vi.fn(() => Promise.resolve()),
  };

  const manyTables = Array.from({ length: MANY }, (_, i) =>
    node({ name: `t${String(i).padStart(4, '0')}`, schema: 'many', oid: 1_000 + i }),
  );

  // `window.tabby` is declared readonly, so it is installed with defineProperty
  // rather than assigned. The renderer's own read path is untouched.
  Object.defineProperty(window, 'tabby', {
    configurable: true,
    value: {
      versions: { electron: '0', chrome: '0', node: '0' },
      db: {
        schemaChildren: (req: { parentSchema: string | null }) => {
          stub.childrenCalls.push(req.parentSchema);
          // `many` comes first so the flattened order is
          // local, many, t0000…t1999, fixtures — which keeps row 2 a table and
          // makes the index arithmetic in the assertions below readable.
          const value =
            req.parentSchema === null
              ? [schemaNode('many'), schemaNode('fixtures')]
              : req.parentSchema === 'many'
                ? manyTables
                : [node({ name: 'big' }), node({ name: 'wide' })];
          return Promise.resolve({ ok: true, value });
        },
        schemaTable: () => Promise.resolve({ ok: true, value: null }),
        refreshSchema: (connectionId: string) => {
          stub.refreshCalls.push(connectionId);
          return Promise.resolve({ ok: true, value: 1 });
        },
      },
      events: {
        onConnectionLost: () => () => undefined,
        onResultEvicted: () => () => undefined,
        onQueryProgress: () => () => undefined,
      },
    },
  });

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: stub.writeText },
  });

  return stub;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let pinia: Pinia;
let stub: Stub;
/** Mounted components, unmounted in `afterEach` so the DOM does not accumulate. */
let wrappers: VueWrapper[];
/** happy-dom reports 0 for every box, which would collapse the window to overscan. */
let savedClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  savedClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
  pinia = createPinia();
  setActivePinia(pinia);
  stub = stubBridge();
  wrappers = [];
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers = [];
  document.body.innerHTML = '';
  if (savedClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', savedClientHeight);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  }
  Reflect.deleteProperty(window, 'tabby');
  vi.restoreAllMocks();
});

function mountTree(): VueWrapper {
  return mount(SchemaTree, { global: { plugins: [pinia] }, attachTo: document.body });
}

function scroller(wrapper: VueWrapper) {
  const found = wrapper.find('[data-tree-scroller]');
  expect(found.exists(), 'the scroller should exist').toBe(true);
  return found;
}

function domRows(wrapper: VueWrapper) {
  return wrapper.findAll('[role="treeitem"]');
}

function labelsOf(wrapper: VueWrapper): string[] {
  return domRows(wrapper).map((row) => row.attributes('data-node-label') ?? '');
}

/**
 * Mounts the pane while no connection is open, then attaches one whose first
 * schema holds 2,000 tables and expands it.
 *
 * Mounting *before* attaching is deliberate: it is the order the real app starts
 * in, and it is the case that caught the scroller never being measured when the
 * element does not exist at `onMounted`.
 */
async function mountWithMany(): Promise<{
  wrapper: VueWrapper;
  schema: ReturnType<typeof useSchemaStore>;
}> {
  const wrapper = mountTree();
  const schema = useSchemaStore();

  schema.attach(CONN, 'local');
  await flush();
  await wrapper.vm.$nextTick();

  const many = schema.rows.find((row) => row.id === MANY_ID);
  if (!many) throw new Error('the "many" schema row is missing');
  schema.toggle(many);
  await flush();
  await wrapper.vm.$nextTick();

  // local + many + its 2,000 tables + the sibling `fixtures`, left unread so the
  // filter tests have an unsearched schema to warn about.
  expect(schema.rows).toHaveLength(MANY + 3);
  wrappers.push(wrapper);
  return { wrapper, schema };
}

describe('virtualisation', () => {
  it('shows an empty state, and no scroller, before a connection is open', () => {
    const wrapper = mountTree();
    expect(wrapper.text()).toContain('Open a connection to browse its schema.');
    expect(wrapper.find('[data-tree-scroller]').exists()).toBe(false);
  });

  it('puts sixteen rows in the DOM for a 2,000-relation schema, not 2,000', async () => {
    const { wrapper, schema } = await mountWithMany();
    expect(schema.rows.length).toBeGreaterThan(MANY);

    // Ten visible rows plus six of overscan below; nothing above row 0.
    expect(domRows(wrapper)).toHaveLength(16);
    expect(labelsOf(wrapper)[0]).toBe('local');
    expect(labelsOf(wrapper)[2]).toBe('t0000');
  });

  it('sizes the spacer to the whole tree, so the scrollbar is honest', async () => {
    const { wrapper, schema } = await mountWithMany();
    const spacer = scroller(wrapper).element.firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${schema.rows.length * 22}px`);
    expect(Number.parseInt(spacer.style.height, 10)).toBeGreaterThan(44_000);
  });

  it('swaps which rows are rendered on scroll, bounded by the viewport', async () => {
    const { wrapper, schema } = await mountWithMany();
    const element = scroller(wrapper).element as HTMLElement;
    const before = labelsOf(wrapper);
    expect(before).toHaveLength(16); // ten visible + six overscan below, none above

    element.scrollTop = 2_200; // row 100
    element.dispatchEvent(new Event('scroll'));
    await wrapper.vm.$nextTick();

    const after = labelsOf(wrapper);
    // Mid-list there is overscan on both sides, so the window is 10 + 6 + 6.
    expect(after).toHaveLength(22);
    expect(after).not.toEqual(before);
    // The invariant that matters: the DOM cost is a function of the viewport, not
    // of the 2,003-row tree behind it.
    expect(after.length).toBeLessThanOrEqual(10 + 2 * DEFAULT_OVERSCAN);
    expect(after.length).toBeLessThan(schema.rows.length / 50);

    // Row 100 of the flattened list is t0098: root, schema, then 98 tables in.
    expect(schema.rows[100]?.label).toBe('t0098');
    expect(after).toContain('t0098');
    expect(after[0]).toBe('t0092'); // row 94, the overscan above
  });

  it('tells assistive technology the real size and position, not the window', async () => {
    const { wrapper, schema } = await mountWithMany();
    const rows = domRows(wrapper);
    expect(rows[0]?.attributes('aria-setsize')).toBe(String(schema.rows.length));
    expect(rows[0]?.attributes('aria-posinset')).toBe('1');
    expect(rows[5]?.attributes('aria-posinset')).toBe('6');

    const element = scroller(wrapper).element as HTMLElement;
    element.scrollTop = 2_200;
    element.dispatchEvent(new Event('scroll'));
    await wrapper.vm.$nextTick();
    // The window moved; the tree did not.
    expect(domRows(wrapper)[0]?.attributes('aria-posinset')).toBe('95');
    expect(domRows(wrapper)[0]?.attributes('aria-setsize')).toBe(String(schema.rows.length));
  });

  it('marks level and expansion state on every row', async () => {
    const { wrapper } = await mountWithMany();
    const rows = domRows(wrapper);
    expect(rows[0]?.attributes('aria-level')).toBe('1');
    expect(rows[0]?.attributes('aria-expanded')).toBe('true');
    expect(rows[1]?.attributes('aria-level')).toBe('2');
    expect(rows[2]?.attributes('aria-level')).toBe('3');
    // A leaf carries no aria-expanded at all: `false` would claim it can be opened.
    expect(rows[2]?.attributes('aria-expanded')).toBeUndefined();
  });
});

describe('pointer interaction', () => {
  it('selects on click and loads the relation into the pane', async () => {
    const { wrapper, schema } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('click');
    expect(schema.selectedId).toBe(childNodeId(MANY_ID, 't0000'));
  });

  it('toggles only on the caret, so clicking a schema does not collapse it', async () => {
    const { wrapper, schema } = await mountWithMany();
    const schemaRow = domRows(wrapper)[1]!;
    const before = schema.rows.length;

    await schemaRow.trigger('click');
    expect(schema.rows).toHaveLength(before);

    await schemaRow.find('.caret').trigger('click');
    expect(schema.rows.length).toBeLessThan(before);
  });

  it('emits open on double-click of a table', async () => {
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('dblclick');
    const emitted = wrapper.emitted('open');
    expect(emitted).toHaveLength(1);
    expect((emitted![0]![0] as { label: string }).label).toBe('t0000');
  });

  it('toggles rather than opening on double-click of a schema', async () => {
    const { wrapper, schema } = await mountWithMany();
    const before = schema.rows.length;
    await domRows(wrapper)[1]!.trigger('dblclick');
    expect(wrapper.emitted('open')).toBeUndefined();
    expect(schema.rows.length).toBeLessThan(before);
  });
});

describe('keyboard', () => {
  it('moves the selection with the arrows', async () => {
    const { wrapper, schema } = await mountWithMany();
    await scroller(wrapper).trigger('keydown', { key: 'ArrowDown' });
    expect(schema.selectedId).toBe(ROOT);
    await scroller(wrapper).trigger('keydown', { key: 'ArrowDown' });
    expect(schema.selectedId).toBe(childNodeId(ROOT, 'many'));
    await scroller(wrapper).trigger('keydown', { key: 'ArrowUp' });
    expect(schema.selectedId).toBe(ROOT);
  });

  it('activates a table on Enter, which is how a keyboard user opens one', async () => {
    const { wrapper, schema } = await mountWithMany();
    schema.selectedId = childNodeId(MANY_ID, 't0000');
    await wrapper.vm.$nextTick();
    await scroller(wrapper).trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toHaveLength(1);
  });

  it('collapses an expanded schema on ArrowLeft instead of jumping to the parent', async () => {
    const { wrapper, schema } = await mountWithMany();
    const manyRow = childNodeId(ROOT, 'many');
    schema.selectedId = manyRow;
    await wrapper.vm.$nextTick();
    const before = schema.rows.length;

    await scroller(wrapper).trigger('keydown', { key: 'ArrowLeft' });
    expect(schema.rows.length).toBeLessThan(before);
    // Selection stays put: collapsing is not navigation.
    expect(schema.selectedId).toBe(manyRow);
  });

  it('does not swallow Tab, which would trap focus in the pane', async () => {
    const { wrapper } = await mountWithMany();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    scroller(wrapper).element.dispatchEvent(event);
    await wrapper.vm.$nextTick();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('filter box', () => {
  it('prunes the rendered rows as the user types', async () => {
    const { wrapper, schema } = await mountWithMany();
    const filter = wrapper.find('[data-tree-filter]');
    await filter.setValue('t1999');
    await flush();
    await wrapper.vm.$nextTick();

    expect(schema.filtering).toBe(true);
    expect(labelsOf(wrapper)).toEqual(['local', 'many', 't1999']);
  });

  it('warns that unread schemas were not searched', async () => {
    const { wrapper } = await mountWithMany();
    await wrapper.find('[data-tree-filter]').setValue('nothing_matches_this');
    await flush();
    await wrapper.vm.$nextTick();
    // `fixtures` was never expanded, so the filter cannot have seen inside it.
    expect(wrapper.text()).toMatch(/schema(s)? not\s*searched/);
  });
});

describe('refresh', () => {
  it('invalidates through the bridge when the button is pressed', async () => {
    const { wrapper } = await mountWithMany();
    await wrapper.find('[data-tree-refresh]').trigger('click');
    await flush();
    await wrapper.vm.$nextTick();
    expect(stub.refreshCalls).toEqual([CONN]);
  });
});

describe('context menu', () => {
  it('opens on right-click with the actions PLAN lists', async () => {
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('contextmenu', { clientX: 40, clientY: 60 });
    await wrapper.vm.$nextTick();

    const menu = wrapper.find('[data-tree-menu]');
    expect(menu.exists()).toBe(true);
    const items = menu.findAll('[role="menuitem"]').map((item) => item.text());
    expect(items).toEqual([
      'Select top 1000',
      'Browse all rows',
      'Copy name',
      'Copy qualified name',
      'Filter to “t0000”',
      'Refresh schema',
    ]);
  });

  it('copies the quoted qualified name, which is the form that actually runs', async () => {
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('contextmenu', { clientX: 10, clientY: 10 });
    await wrapper.vm.$nextTick();

    const items = wrapper.findAll('[data-tree-menu] [role="menuitem"]');
    await items[3]!.trigger('click');
    await flush();

    expect(stub.writeText).toHaveBeenCalledWith('"many"."t0000"');
    expect(wrapper.find('[data-tree-menu]').exists()).toBe(false);
  });

  it('refuses to copy a qualified name for the connection node', async () => {
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[0]!.trigger('contextmenu', { clientX: 10, clientY: 10 });
    await wrapper.vm.$nextTick();
    const items = wrapper.findAll('[data-tree-menu] [role="menuitem"]');
    expect(items[0]!.attributes('disabled')).toBeDefined();
    expect(items[3]!.attributes('disabled')).toBeDefined();
  });

  it('filters to the right-clicked name', async () => {
    const { wrapper, schema } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('contextmenu', { clientX: 10, clientY: 10 });
    await wrapper.vm.$nextTick();
    await wrapper.findAll('[data-tree-menu] [role="menuitem"]')[4]!.trigger('click');
    await flush();
    await wrapper.vm.$nextTick();

    expect(schema.filter).toBe('t0000');
    expect(labelsOf(wrapper)).toContain('t0000');
  });

  it('emits openTop for "Select top 1000"', async () => {
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('contextmenu', { clientX: 10, clientY: 10 });
    await wrapper.vm.$nextTick();
    await wrapper.findAll('[data-tree-menu] [role="menuitem"]')[0]!.trigger('click');
    await flush();

    const emitted = wrapper.emitted('openTop');
    expect(emitted).toHaveLength(1);
    expect((emitted![0]![0] as { label: string }).label).toBe('t0000');
  });

  it('reports a clipboard refusal instead of failing silently', async () => {
    stub.writeText.mockRejectedValueOnce(new Error('denied'));
    const { wrapper } = await mountWithMany();
    await domRows(wrapper)[2]!.trigger('contextmenu', { clientX: 10, clientY: 10 });
    await wrapper.vm.$nextTick();
    await wrapper.findAll('[data-tree-menu] [role="menuitem"]')[2]!.trigger('click');
    await flush();
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('notice')?.[0]?.[0]).toMatch(/Clipboard refused/);
  });
});
