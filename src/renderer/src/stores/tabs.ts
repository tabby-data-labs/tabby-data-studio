import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export type TabKind = 'query' | 'result';

/**
 * Immutable by design: `rename` replaces the object rather than mutating a
 * field, so Vue's reactivity and any `watch` on the tab list both fire.
 */
export interface Tab {
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  readonly connectionId: string | null;
  /** Set for result tabs; null for a query editor tab. */
  readonly resultId: string | null;
  readonly createdAt: number;
}

export interface OpenResultInput {
  readonly resultId: string;
  readonly title: string;
  readonly connectionId: string | null;
}

/** Long enough to be readable in a tab strip, short enough not to break layout. */
const MAX_TITLE_LENGTH = 120;

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `tab-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The tab model for query editors and result sets.
 *
 * Deliberately a plain state machine with no IPC and no DOM: it is Tier 1 under
 * AGENTS.md, and keeping it pure is what lets the close/activate rules — the part
 * that annoys users when it is wrong — be tested exhaustively.
 */
export const useTabsStore = defineStore('tabs', () => {
  const list = ref<Tab[]>([]);
  const activeId = ref<string | null>(null);
  /**
   * Monotonic per store, not derived from the current tab count, so closing a
   * tab never causes a later one to reuse its number.
   */
  let querySequence = 0;

  const all = computed<readonly Tab[]>(() => list.value);
  const count = computed(() => list.value.length);
  const queries = computed(() => list.value.filter((tab) => tab.kind === 'query'));
  const results = computed(() => list.value.filter((tab) => tab.kind === 'result'));
  const active = computed(() => list.value.find((tab) => tab.id === activeId.value) ?? null);

  function byId(id: string): Tab | null {
    return list.value.find((tab) => tab.id === id) ?? null;
  }

  function byResultId(resultId: string): Tab | null {
    return list.value.find((tab) => tab.resultId === resultId) ?? null;
  }

  function indexOf(id: string): number {
    return list.value.findIndex((tab) => tab.id === id);
  }

  function openQuery(connectionId: string | null): Tab {
    querySequence += 1;
    const tab: Tab = {
      id: nextId(),
      kind: 'query',
      title: `Query ${querySequence}`,
      connectionId,
      resultId: null,
      createdAt: Date.now(),
    };
    list.value = [...list.value, tab];
    activeId.value = tab.id;
    return tab;
  }

  function openResult(input: OpenResultInput): Tab {
    const tab: Tab = {
      id: nextId(),
      kind: 'result',
      title: input.title,
      connectionId: input.connectionId,
      resultId: input.resultId,
      createdAt: Date.now(),
    };
    list.value = [...list.value, tab];
    activeId.value = tab.id;
    return tab;
  }

  function select(id: string): void {
    // An unknown id must not clear the selection: a stale click on a tab that
    // was just closed should not leave the user with nothing active.
    if (indexOf(id) < 0) return;
    activeId.value = id;
  }

  function close(id: string): void {
    const index = indexOf(id);
    if (index < 0) return;

    const wasActive = activeId.value === id;
    const next = list.value.filter((tab) => tab.id !== id);
    list.value = next;

    if (!wasActive) return;
    if (next.length === 0) {
      activeId.value = null;
      return;
    }
    // Prefer the tab that slid into the closed one's place; fall back leftwards
    // when the last tab in the strip was closed.
    activeId.value = (next[Math.min(index, next.length - 1)] ?? next[next.length - 1]!).id;
  }

  /** Cyclic, so Ctrl+Tab held down keeps moving rather than stopping at an end. */
  function selectNeighbour(direction: 1 | -1): void {
    const total = list.value.length;
    if (total === 0) return;
    const current = indexOf(activeId.value ?? '');
    if (current < 0) {
      activeId.value = (list.value[0] ?? null)?.id ?? null;
      return;
    }
    const next = (current + direction + total) % total;
    activeId.value = (list.value[next] ?? null)?.id ?? null;
  }

  function rename(id: string, title: string): void {
    const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
    // Refusing to blank a title beats leaving an unlabelled tab the user cannot
    // identify in the strip.
    if (trimmed === '') return;
    list.value = list.value.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
  }

  function closeOthers(id: string): void {
    const keep = byId(id);
    if (!keep) return;
    list.value = [keep];
    activeId.value = keep.id;
  }

  function closeAll(): void {
    list.value = [];
    activeId.value = null;
  }

  return {
    all,
    count,
    queries,
    results,
    active,
    activeId,
    byId,
    byResultId,
    indexOf,
    openQuery,
    openResult,
    select,
    close,
    selectNeighbour,
    rename,
    closeOthers,
    closeAll,
  };
});
