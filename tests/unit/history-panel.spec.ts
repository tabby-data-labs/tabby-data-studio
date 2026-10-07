// @vitest-environment happy-dom
/**
 * The query-history panel (PLAN Phase 7).
 *
 * Tier 2 — Vue plus DOM, written after the implementation. The store's async
 * behaviour is covered in `history-store.spec.ts`; what only a mounted component
 * can show is the two things that would hurt a user:
 *
 *  - clicking a row restores the statement **verbatim**, not the collapsed preview
 *    that is on screen — a preview is for reading, and re-running one would silently
 *    flatten the formatting the user wrote;
 *  - an entry that was too long to store in full refuses to load, because running a
 *    prefix of a statement is running a different statement.
 *
 * Plus the destructive-action affordances: "Clear all" takes two clicks, Escape
 * closes, and the privacy note is actually rendered rather than living only in PLAN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { HistoryEntry } from '@shared/history';
import type { HistoryListResponse } from '@shared/ipc-contract';
import type { Result } from '@shared/errors';
import HistoryPanel from '@/components/HistoryPanel.vue';
import { useHistoryStore } from '@/stores/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    sql: 'select 1',
    truncated: false,
    connectionId: 'c1',
    connectionLabel: 'Local · localhost:5432/postgres',
    ranAt: 1_700_000_000_000,
    elapsedMs: 4,
    rowCount: 1,
    status: 'ok',
    ...overrides,
  };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

let listResult: Result<HistoryListResponse>;
let deleteResult: Result<void>;
let clearResult: Result<number>;
let cleared: number;
let deleted: string[];

function stubApi(): void {
  listResult = ok({ entries: [], skipped: 0, warning: null });
  deleteResult = ok(undefined);
  clearResult = ok(0);
  cleared = 0;
  deleted = [];

  // `tabby` alone, never `window`: replacing the whole global takes happy-dom's
  // `Event`, `KeyboardEvent` and `document` with it, and @vue/test-utils then
  // cannot construct a trigger event ("SupportedEventInterface is not a
  // constructor"). In this environment `window === globalThis`, so stubbing the
  // one property is also what the renderer actually reads.
  vi.stubGlobal('tabby', {
    versions: { electron: '0', chrome: '0', node: '0' },
    db: {
      historyList: () => Promise.resolve(listResult),
      historyAdd: () => Promise.resolve(ok(entry())),
      historyDelete: (historyId: string) => {
        deleted.push(historyId);
        return Promise.resolve(deleteResult);
      },
      historyClear: () => {
        cleared += 1;
        return Promise.resolve(clearResult);
      },
    },
    events: {},
  });
}

let pinia: Pinia;

/**
 * Every mounted panel, so `afterEach` can unmount them.
 *
 * The component installs a `document`-level keydown listener for Escape. Left
 * mounted, each test adds another one, and a later test's Escape would be answered
 * by an earlier test's component — the "stops listening when unmounted" assertion
 * would then be testing nothing.
 */
const mounted: VueWrapper[] = [];

function mountPanel(): VueWrapper {
  const wrapper = mount(HistoryPanel, { global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

function unmountNow(wrapper: VueWrapper): void {
  const index = mounted.indexOf(wrapper);
  if (index >= 0) mounted.splice(index, 1);
  wrapper.unmount();
}

/** Seeds the store from the stub and mounts, so the panel renders real entries. */
async function mountWith(entries: readonly HistoryEntry[]): Promise<VueWrapper> {
  listResult = ok({ entries, skipped: 0, warning: null });
  const store = useHistoryStore();
  await store.refresh();
  // The panel is mounted unconditionally here; in the app it sits behind a `v-if`.
  // Setting `open` makes the close-on-load and close-on-Escape assertions mean
  // something rather than passing against a flag that was never raised.
  store.open = true;
  return mountPanel();
}

function items(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-history-item]').map((item) => item.text());
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  stubApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('empty and loading states', () => {
  it('says nothing has been run rather than showing a blank box', async () => {
    const wrapper = await mountWith([]);
    expect(wrapper.find('[data-history-empty]').exists()).toBe(true);
    expect(wrapper.find('[data-history-item]').exists()).toBe(false);
    expect(wrapper.find('[data-history-empty]').text()).toContain('Nothing has been run yet');
  });

  it('disables "Clear all" when there is nothing to clear', async () => {
    const wrapper = await mountWith([]);
    expect(wrapper.find('[data-history-clear]').attributes('disabled')).toBeDefined();
  });
});

describe('rendering a list', () => {
  it('renders one row per entry, newest first, with its outcome and connection', async () => {
    const wrapper = await mountWith([
      entry({
        id: 'a',
        sql: 'select * from fixtures.big',
        status: 'ok',
        rowCount: 10,
        elapsedMs: 7,
      }),
      entry({ id: 'b', sql: 'select nope', status: 'failed', rowCount: -1, elapsedMs: -1 }),
    ]);

    const rows = wrapper.findAll('[data-history-item]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('select * from fixtures.big');
    expect(rows[0]!.text()).toContain('10 rows');
    expect(rows[0]!.text()).toContain('7ms');
    expect(rows[0]!.text()).toContain('Local · localhost:5432/postgres');
    expect(rows[1]!.text()).toContain('failed');
    expect(rows[1]!.text()).not.toContain('rows');
  });

  it('falls back to the connection id when no label was captured', async () => {
    const wrapper = await mountWith([entry({ connectionLabel: '', connectionId: 'conn-42' })]);
    expect(wrapper.find('[data-history-item]').text()).toContain('conn-42');
  });

  it('shows a cancelled run as cancelled, with no invented numbers', async () => {
    const wrapper = await mountWith([entry({ status: 'cancelled', elapsedMs: -1, rowCount: -1 })]);
    const text = wrapper.find('[data-history-item]').text();
    expect(text).toContain('cancelled');
    expect(text).not.toContain('rows');
  });

  it('says "unknown time" for a timestamp that cannot be a date', async () => {
    // A hand-edited file, or a clock that jumped. "Invalid Date" would read as a crash.
    const wrapper = await mountWith([entry({ ranAt: Number.NaN })]);
    expect(wrapper.find('[data-history-item]').text()).toContain('unknown time');
  });

  it('previews a long statement instead of rendering all of it', async () => {
    const wrapper = await mountWith([entry({ sql: `select ${'x'.repeat(400)}` })]);
    const code = wrapper.find('[data-history-item] .sql').text();
    expect(code.length).toBeLessThan(200);
    expect(code.endsWith('…')).toBe(true);
    // The whole statement is still reachable to a screen reader and a hover.
    expect(wrapper.find('[data-history-load]').attributes('title')).toContain('x'.repeat(400));
  });

  it('marks a truncated entry, and refuses to load it', async () => {
    const wrapper = await mountWith([entry({ sql: 'select partial', truncated: true })]);
    expect(wrapper.find('[data-history-truncated]').exists()).toBe(true);

    await wrapper.find('[data-history-load]').trigger('click');
    expect(wrapper.emitted('load')).toBeUndefined();
    expect(wrapper.emitted('notice')?.[0]?.[0]).toContain('too long to store in full');
  });

  it('counts what is visible separately from what is stored', async () => {
    const wrapper = await mountWith([entry({ id: 'a' }), entry({ id: 'b' })]);
    expect(wrapper.find('[data-history-count]').text()).toBe('2 shown');
  });
});

describe('loading a statement', () => {
  it('emits the stored SQL verbatim, not the collapsed preview', async () => {
    const sql = 'select a,\n       b\n  from t';
    const wrapper = await mountWith([entry({ sql })]);
    await wrapper.find('[data-history-load]').trigger('click');

    const [emitted] = wrapper.emitted('load') ?? [];
    expect(emitted).toEqual([sql]);
    expect(String(emitted?.[0])).toContain('\n');
    // What is on screen is the one-line preview; what leaves the panel is not.
    for (const row of items(wrapper)) expect(row).not.toContain('\n');
  });

  it('closes the panel afterwards', async () => {
    const wrapper = await mountWith([entry()]);
    await wrapper.find('[data-history-load]').trigger('click');
    await flush();
    expect(useHistoryStore().open).toBe(false);
  });
});

describe('deleting one entry', () => {
  it('asks main, then drops the row', async () => {
    const wrapper = await mountWith([entry({ id: 'a' }), entry({ id: 'b', sql: 'select 2' })]);
    await wrapper.findAll('[data-history-delete]')[0]!.trigger('click');
    await flush();

    expect(deleted).toEqual(['a']);
    expect(wrapper.findAll('[data-history-item]')).toHaveLength(1);
    expect(wrapper.find('[data-history-item]').text()).toContain('select 2');
    expect(wrapper.emitted('notice')?.[0]?.[0]).toBe('Removed from history');
  });

  it('reports a refusal instead of pretending the row is gone', async () => {
    deleteResult = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'no history entry with id a' },
    };
    const wrapper = await mountWith([entry({ id: 'a' })]);
    await wrapper.find('[data-history-delete]').trigger('click');
    await flush();

    expect(wrapper.findAll('[data-history-item]')).toHaveLength(1);
    expect(wrapper.emitted('notice')?.[0]?.[0]).toContain('no history entry with id a');
  });
});

describe('clearing everything', () => {
  it('takes two clicks, so a stray one cannot destroy the log', async () => {
    const wrapper = await mountWith([entry({ id: 'a' }), entry({ id: 'b' })]);

    await wrapper.find('[data-history-clear]').trigger('click');
    expect(cleared).toBe(0);
    expect(wrapper.find('[data-history-clear]').text()).toContain('Click again');

    clearResult = ok(2);
    await wrapper.find('[data-history-clear]').trigger('click');
    await flush();

    expect(cleared).toBe(1);
    expect(wrapper.find('[data-history-empty]').exists()).toBe(true);
    expect(wrapper.emitted('notice')?.[0]?.[0]).toBe('Cleared 2 history entries');
  });

  it('singularises the notice for one entry', async () => {
    clearResult = ok(1);
    const wrapper = await mountWith([entry()]);
    await wrapper.find('[data-history-clear]').trigger('click');
    await wrapper.find('[data-history-clear]').trigger('click');
    await flush();
    expect(wrapper.emitted('notice')?.[0]?.[0]).toBe('Cleared 1 history entry');
  });

  it('reports a failed clear rather than showing an empty panel', async () => {
    clearResult = { ok: false, error: { code: 'INTERNAL', message: 'could not be cleared' } };
    const wrapper = await mountWith([entry()]);
    await wrapper.find('[data-history-clear]').trigger('click');
    await wrapper.find('[data-history-clear]').trigger('click');
    await flush();

    expect(wrapper.findAll('[data-history-item]')).toHaveLength(1);
    expect(wrapper.emitted('notice')?.[0]?.[0]).toContain('could not be cleared');
  });
});

describe('filtering', () => {
  it('narrows the list as the user types, and says so when nothing matches', async () => {
    const wrapper = await mountWith([
      entry({ id: 'a', sql: 'select * from fixtures.big' }),
      entry({ id: 'b', sql: 'select * from fixtures.wide' }),
    ]);

    const search = wrapper.find('[data-history-search]');
    await search.setValue('wide');
    expect(wrapper.findAll('[data-history-item]')).toHaveLength(1);
    expect(wrapper.find('[data-history-item]').text()).toContain('fixtures.wide');
    expect(wrapper.find('[data-history-count]').text()).toBe('1 shown');

    await search.setValue('nothing matches this');
    expect(wrapper.find('[data-history-no-match]').exists()).toBe(true);
    expect(wrapper.find('[data-history-no-match]').text()).toContain('nothing matches this');
    // The store still holds both; only the view is narrowed.
    expect(useHistoryStore().count).toBe(2);
  });
});

describe('surfacing what main could not do', () => {
  it('shows a store warning, a skipped-line count and an error', async () => {
    listResult = ok({
      entries: [entry()],
      skipped: 4,
      warning: 'could not read history.1.jsonl: EISDIR',
    });
    const store = useHistoryStore();
    await store.refresh();
    store.error = { code: 'INTERNAL', message: 'the query history could not be written' };

    const wrapper = mountPanel();
    expect(wrapper.find('[data-history-warning]').text()).toContain('history.1.jsonl');
    expect(wrapper.find('[data-history-skipped]').text()).toContain('4 unreadable lines skipped');
    expect(wrapper.find('[data-history-error]').text()).toContain('INTERNAL');
  });

  it('singularises the skipped-line count', async () => {
    listResult = ok({ entries: [], skipped: 1, warning: null });
    const store = useHistoryStore();
    await store.refresh();
    expect(mountPanel().find('[data-history-skipped]').text()).toContain(
      '1 unreadable line skipped',
    );
  });
});

describe('the panel as a dialog', () => {
  it('is labelled, and states the privacy position where the secrets are listed', async () => {
    const wrapper = await mountWith([entry()]);
    expect(wrapper.find('[data-history-panel]').attributes('role')).toBe('dialog');
    expect(wrapper.find('[data-history-panel]').attributes('aria-label')).toBe('Query history');
    expect(wrapper.text()).toContain('never synced');
  });

  it('closes on Escape', async () => {
    const wrapper = await mountWith([entry()]);
    expect(useHistoryStore().open).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();

    expect(useHistoryStore().open).toBe(false);
    expect(wrapper.exists()).toBe(true);
  });

  it('stops listening when it is unmounted', async () => {
    const wrapper = await mountWith([entry()]);
    unmountNow(wrapper);

    useHistoryStore().open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    // Still open: the listener that would have closed it is gone with the component.
    expect(useHistoryStore().open).toBe(true);
  });
});
