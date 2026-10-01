/**
 * The tab model (PLAN Phase 3: "Tab UI shell — result tabs, query tabs").
 *
 * Pure state machine with no DOM, IPC or Electron, so per AGENTS.md it is Tier 1
 * and written test-first. Expectations come from how every tabbed editor behaves
 * (VS Code, browsers, DBeaver), not from the implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTabsStore } from '@/stores/tabs';

let tabs: ReturnType<typeof useTabsStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  tabs = useTabsStore();
});

describe('opening', () => {
  it('starts empty with no active tab', () => {
    expect(tabs.all).toEqual([]);
    expect(tabs.activeId).toBeNull();
    expect(tabs.active).toBeNull();
  });

  it('appends and activates a new query tab', () => {
    const tab = tabs.openQuery('conn-1');
    expect(tabs.all).toHaveLength(1);
    expect(tabs.activeId).toBe(tab.id);
    expect(tab.kind).toBe('query');
    expect(tab.connectionId).toBe('conn-1');
    expect(tab.resultId).toBeNull();
  });

  it('appends and activates a new result tab', () => {
    const tab = tabs.openResult({ resultId: 'r1', title: 'SELECT 1', connectionId: 'conn-1' });
    expect(tab.kind).toBe('result');
    expect(tab.resultId).toBe('r1');
    expect(tabs.activeId).toBe(tab.id);
  });

  it('assigns unique ids', () => {
    const ids = new Set([
      tabs.openQuery(null).id,
      tabs.openQuery(null).id,
      tabs.openQuery(null).id,
    ]);
    expect(ids.size).toBe(3);
  });

  it('numbers duplicate query titles instead of showing three identical tabs', () => {
    expect(tabs.openQuery(null).title).toBe('Query 1');
    expect(tabs.openQuery(null).title).toBe('Query 2');
    expect(tabs.openQuery(null).title).toBe('Query 3');
  });

  it('allows a query tab with no connection yet', () => {
    expect(tabs.openQuery(null).connectionId).toBeNull();
  });
});

describe('closing', () => {
  it('removes the tab', () => {
    const a = tabs.openQuery(null);
    tabs.close(a.id);
    expect(tabs.all).toEqual([]);
    expect(tabs.activeId).toBeNull();
  });

  it('activates the right-hand neighbour when closing the active tab', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    const c = tabs.openQuery(null);
    tabs.select(b.id);
    tabs.close(b.id);
    expect(tabs.activeId).toBe(c.id);
    expect(tabs.all.map((t) => t.id)).toEqual([a.id, c.id]);
  });

  it('falls back to the left neighbour when closing the last tab in the strip', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    tabs.close(b.id);
    expect(tabs.activeId).toBe(a.id);
  });

  it('leaves the active tab alone when closing a background tab', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    tabs.select(a.id);
    tabs.close(b.id);
    expect(tabs.activeId).toBe(a.id);
  });

  it('ignores an unknown id', () => {
    const a = tabs.openQuery(null);
    tabs.close('nope');
    expect(tabs.all).toHaveLength(1);
    expect(tabs.activeId).toBe(a.id);
  });

  it('closing every tab one by one ends in the empty state', () => {
    const ids = [tabs.openQuery(null).id, tabs.openQuery(null).id, tabs.openQuery(null).id];
    for (const id of ids) tabs.close(id);
    expect(tabs.all).toEqual([]);
    expect(tabs.activeId).toBeNull();
    expect(tabs.active).toBeNull();
  });
});

describe('selecting', () => {
  it('switches the active tab', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    tabs.select(a.id);
    expect(tabs.activeId).toBe(a.id);
    tabs.select(b.id);
    expect(tabs.activeId).toBe(b.id);
  });

  it('ignores an unknown id rather than clearing the selection', () => {
    const a = tabs.openQuery(null);
    tabs.select('nope');
    expect(tabs.activeId).toBe(a.id);
  });

  it('selects the next and previous tab cyclically', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    const c = tabs.openQuery(null);
    tabs.select(a.id);

    tabs.selectNeighbour(1);
    expect(tabs.activeId).toBe(b.id);
    tabs.selectNeighbour(1);
    expect(tabs.activeId).toBe(c.id);
    tabs.selectNeighbour(1);
    expect(tabs.activeId).toBe(a.id); // wraps

    tabs.selectNeighbour(-1);
    expect(tabs.activeId).toBe(c.id); // wraps back
  });

  it('neighbour navigation is a no-op with no tabs', () => {
    expect(() => tabs.selectNeighbour(1)).not.toThrow();
    expect(tabs.activeId).toBeNull();
  });

  it('reports the index of a tab', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    expect(tabs.indexOf(a.id)).toBe(0);
    expect(tabs.indexOf(b.id)).toBe(1);
    expect(tabs.indexOf('nope')).toBe(-1);
  });
});

describe('renaming', () => {
  it('updates the title', () => {
    const a = tabs.openQuery(null);
    tabs.rename(a.id, 'nightly report');
    expect(tabs.byId(a.id)?.title).toBe('nightly report');
  });

  it('trims surrounding whitespace', () => {
    const a = tabs.openQuery(null);
    tabs.rename(a.id, '  padded  ');
    expect(tabs.byId(a.id)?.title).toBe('padded');
  });

  it('refuses to blank a title, keeping the old one', () => {
    const a = tabs.openQuery(null);
    tabs.rename(a.id, '   ');
    expect(tabs.byId(a.id)?.title).toBe('Query 1');
  });

  it('caps an absurdly long title', () => {
    const a = tabs.openQuery(null);
    tabs.rename(a.id, 'x'.repeat(500));
    expect((tabs.byId(a.id)?.title ?? '').length).toBeLessThanOrEqual(120);
  });

  it('ignores an unknown id', () => {
    tabs.openQuery(null);
    expect(() => tabs.rename('nope', 'x')).not.toThrow();
  });
});

describe('bulk close', () => {
  it('closeOthers keeps only the given tab and makes it active', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    const c = tabs.openQuery(null);
    tabs.closeOthers(b.id);
    expect(tabs.all.map((t) => t.id)).toEqual([b.id]);
    expect(tabs.activeId).toBe(b.id);
    void a;
    void c;
  });

  it('closeOthers ignores an unknown id', () => {
    const a = tabs.openQuery(null);
    tabs.closeOthers('nope');
    expect(tabs.all.map((t) => t.id)).toEqual([a.id]);
  });

  it('closeAll empties the strip', () => {
    tabs.openQuery(null);
    tabs.openResult({ resultId: 'r1', title: 'x', connectionId: null });
    tabs.closeAll();
    expect(tabs.all).toEqual([]);
    expect(tabs.activeId).toBeNull();
  });
});

describe('derived views', () => {
  it('separates query tabs from result tabs', () => {
    tabs.openQuery('c1');
    tabs.openResult({ resultId: 'r1', title: 'a', connectionId: 'c1' });
    tabs.openResult({ resultId: 'r2', title: 'b', connectionId: 'c1' });

    expect(tabs.queries).toHaveLength(1);
    expect(tabs.results).toHaveLength(2);
  });

  it('finds a tab by id and returns null when absent', () => {
    const a = tabs.openQuery(null);
    expect(tabs.byId(a.id)?.id).toBe(a.id);
    expect(tabs.byId('nope')).toBeNull();
  });

  it('can find the result tab for a resultId, so a re-fetch focuses it', () => {
    tabs.openResult({ resultId: 'r1', title: 'a', connectionId: null });
    const second = tabs.openResult({ resultId: 'r2', title: 'b', connectionId: null });
    expect(tabs.byResultId('r2')?.id).toBe(second.id);
    expect(tabs.byResultId('missing')).toBeNull();
  });

  it('exposes a count for the UI badge', () => {
    tabs.openQuery(null);
    tabs.openQuery(null);
    expect(tabs.count).toBe(2);
  });
});

describe('ordering', () => {
  it('preserves insertion order', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openResult({ resultId: 'r1', title: 'r', connectionId: null });
    const c = tabs.openQuery(null);
    expect(tabs.all.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  it('closing a middle tab keeps the remaining order', () => {
    const a = tabs.openQuery(null);
    const b = tabs.openQuery(null);
    const c = tabs.openQuery(null);
    tabs.close(b.id);
    expect(tabs.all.map((t) => t.id)).toEqual([a.id, c.id]);
  });
});
