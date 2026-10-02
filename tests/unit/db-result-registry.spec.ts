/**
 * The bounded result registry (PLAN Phase 4, ARCHITECTURE §5.3).
 *
 * Tier 1, written test-first: pure logic with an injected clock, no pg and no
 * Electron. The registry is what stops a long session from holding a cursor —
 * and therefore an xmin horizon — open forever on somebody's production
 * database, so its bounds are the feature, not the bookkeeping.
 *
 * Expectations come from the stated contract (bounded count, TTL, LRU eviction,
 * memory cap, eviction events) and from the invariants that break quietly:
 * byte accounting after a replace, and an entry too large for the cap on its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ResultRegistry,
  type EvictionReason,
  type ResultEntry,
} from '../../src/main/db/result-registry';

interface Payload {
  readonly label: string;
}

interface Eviction {
  readonly resultId: string;
  readonly reason: EvictionReason;
}

let clock: number;
let evictions: Eviction[];

function makeRegistry(
  overrides: Partial<ConstructorParameters<typeof ResultRegistry<Payload>>[0]> = {},
) {
  return new ResultRegistry<Payload>({
    maxEntries: 3,
    ttlMs: 60_000,
    maxBytes: 1_000,
    now: () => clock,
    onEvict: (entry: ResultEntry<Payload>, reason: EvictionReason) => {
      evictions.push({ resultId: entry.resultId, reason });
    },
    ...overrides,
  });
}

function add(
  registry: ResultRegistry<Payload>,
  resultId: string,
  bytesHeld = 100,
  connectionId = 'c1',
) {
  return registry.set({ resultId, connectionId, payload: { label: resultId }, bytesHeld });
}

beforeEach(() => {
  clock = 1_000_000;
  evictions = [];
});

describe('construction', () => {
  it('rejects bounds that would make the registry useless or unbounded', () => {
    expect(() => makeRegistry({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => makeRegistry({ maxEntries: -1 })).toThrow(/maxEntries/);
    expect(() => makeRegistry({ maxEntries: 1.5 })).toThrow(/maxEntries/);
    expect(() => makeRegistry({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => makeRegistry({ maxBytes: -10 })).toThrow(/maxBytes/);
    // Zero TTL would evict a result the instant it was created, so "no TTL" has
    // to be expressed as Infinity rather than as 0.
    expect(() => makeRegistry({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => makeRegistry({ ttlMs: -1 })).toThrow(/ttlMs/);
    expect(() => makeRegistry({ ttlMs: Number.NaN })).toThrow(/ttlMs/);
  });

  it('accepts an infinite TTL and a single-entry registry', () => {
    expect(() => makeRegistry({ ttlMs: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() => makeRegistry({ maxEntries: 1 })).not.toThrow();
  });

  it('starts empty', () => {
    const registry = makeRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.totalBytes()).toBe(0);
    expect(registry.ids()).toEqual([]);
  });
});

describe('set and get', () => {
  it('stores and retrieves a payload', () => {
    const registry = makeRegistry();
    expect(add(registry, 'r1')).toBe(true);
    expect(registry.get('r1')?.payload).toEqual({ label: 'r1' });
    expect(registry.has('r1')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('returns null for an unknown id rather than throwing', () => {
    const registry = makeRegistry();
    expect(registry.get('nope')).toBeNull();
    expect(registry.has('nope')).toBe(false);
  });

  it('carries the connection id, so a lost connection can drop its results', () => {
    const registry = makeRegistry();
    add(registry, 'r1', 10, 'conn-a');
    add(registry, 'r2', 10, 'conn-b');
    expect(registry.get('r1')?.connectionId).toBe('conn-a');
    expect(registry.idsForConnection('conn-b')).toEqual(['r2']);
    expect(registry.idsForConnection('conn-missing')).toEqual([]);
  });

  it('replaces an existing id without double-counting its bytes', () => {
    const registry = makeRegistry();
    add(registry, 'r1', 100);
    add(registry, 'r1', 250);
    expect(registry.size()).toBe(1);
    expect(registry.totalBytes()).toBe(250);
    // Replacing must not look like an eviction to the renderer, which would show
    // "result expired — re-run query" for a result that is still there.
    expect(evictions).toEqual([]);
  });

  it('keeps totalBytes equal to the sum of live entries through a churn of operations', () => {
    const registry = makeRegistry({ maxEntries: 10, maxBytes: 100_000 });
    const live = new Map<string, number>();
    const sizes = [10, 250, 7, 4_000, 99, 1];

    for (let round = 0; round < 40; round += 1) {
      const id = `r${round % 7}`;
      const bytes = sizes[round % sizes.length]!;
      if (registry.has(id)) live.delete(id);
      if (add(registry, id, bytes)) live.set(id, bytes);
      const victim = `r${(round + 3) % 7}`;
      if (round % 5 === 0 && registry.delete(victim)) live.delete(victim);

      let expected = 0;
      for (const bytes of live.values()) expected += bytes;
      expect(registry.totalBytes(), `round ${round}`).toBe(expected);
    }
  });
});

describe('count bound and LRU order', () => {
  it('evicts the least recently used entry when the count bound is exceeded', () => {
    const registry = makeRegistry({ maxEntries: 3 });
    add(registry, 'r1');
    add(registry, 'r2');
    add(registry, 'r3');
    add(registry, 'r4');

    expect(registry.size()).toBe(3);
    expect(registry.has('r1')).toBe(false);
    expect(registry.ids()).toEqual(['r2', 'r3', 'r4']);
    expect(evictions).toEqual([{ resultId: 'r1', reason: 'capacity' }]);
  });

  it('counts a read as recent use, so a different entry is evicted next', () => {
    const registry = makeRegistry({ maxEntries: 3 });
    add(registry, 'r1');
    add(registry, 'r2');
    add(registry, 'r3');

    registry.get('r1'); // r2 is now the oldest
    add(registry, 'r4');

    expect(registry.has('r1')).toBe(true);
    expect(registry.has('r2')).toBe(false);
    expect(evictions).toEqual([{ resultId: 'r2', reason: 'capacity' }]);
  });

  it('does not let peek-style lookups disturb the order', () => {
    const registry = makeRegistry({ maxEntries: 2 });
    add(registry, 'r1');
    add(registry, 'r2');
    expect(registry.has('r1')).toBe(true);
    add(registry, 'r3');
    // `has` is a membership test, not a use: r1 must still be the oldest.
    expect(registry.has('r1')).toBe(false);
    expect(registry.has('r2')).toBe(true);
  });

  it('evicts as many entries as needed for one large insert', () => {
    const registry = makeRegistry({ maxEntries: 5, maxBytes: 1_000 });
    add(registry, 'r1', 300);
    add(registry, 'r2', 300);
    add(registry, 'r3', 300);
    expect(add(registry, 'big', 900)).toBe(true);
    expect(registry.ids()).toEqual(['big']);
    expect(registry.totalBytes()).toBe(900);
    expect(evictions.map((e) => e.resultId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('never evicts the entry it is making room for', () => {
    const registry = makeRegistry({ maxEntries: 1, maxBytes: 1_000 });
    add(registry, 'r1', 100);
    expect(add(registry, 'r2', 900)).toBe(true);
    expect(registry.ids()).toEqual(['r2']);
    expect(evictions).toEqual([{ resultId: 'r1', reason: 'capacity' }]);
  });
});

describe('memory cap', () => {
  it('refuses an entry that cannot fit even on its own', () => {
    const registry = makeRegistry({ maxBytes: 1_000 });
    add(registry, 'r1', 400);
    // Accepting it would mean evicting everything and still being over the cap —
    // a registry that thrashes is worse than one that says no.
    expect(add(registry, 'huge', 5_000)).toBe(false);
    expect(registry.has('huge')).toBe(false);
    expect(registry.has('r1')).toBe(true);
    expect(evictions).toEqual([]);
  });

  it('evicts LRU entries until a new one fits', () => {
    const registry = makeRegistry({ maxEntries: 10, maxBytes: 1_000 });
    add(registry, 'r1', 300);
    add(registry, 'r2', 300);
    add(registry, 'r3', 300);
    expect(registry.ids()).toEqual(['r1', 'r2', 'r3']);

    // 900 held + 500 incoming is over the cap, so the two oldest go: 300 + 500
    // is the first total that fits.
    expect(add(registry, 'r4', 500)).toBe(true);
    expect(registry.totalBytes()).toBe(800);
    expect(registry.has('r1')).toBe(false);
    expect(registry.has('r2')).toBe(false);
    expect(registry.ids()).toEqual(['r3', 'r4']);
    expect(evictions.map((e) => e.resultId)).toEqual(['r1', 'r2']);
  });

  it('grows the accounting when a result caches more rows', () => {
    const registry = makeRegistry({ maxEntries: 10, maxBytes: 10_000 });
    add(registry, 'r1', 100);
    add(registry, 'r2', 100);
    expect(registry.addBytes('r1', 500)).toBe(true);
    expect(registry.totalBytes()).toBe(700);
    expect(registry.get('r1')?.bytesHeld).toBe(600);
  });

  it('evicts other entries when growth pushes past the cap', () => {
    const registry = makeRegistry({ maxEntries: 10, maxBytes: 1_000 });
    add(registry, 'r1', 100);
    add(registry, 'r2', 400);
    add(registry, 'r3', 400);
    registry.get('r1'); // r2 becomes the oldest
    registry.addBytes('r1', 500);
    expect(registry.totalBytes()).toBeLessThanOrEqual(1_000);
    expect(registry.has('r2')).toBe(false);
    expect(evictions).toEqual([{ resultId: 'r2', reason: 'capacity' }]);
  });

  it('clamps a negative delta at zero rather than letting bytes go missing', () => {
    const registry = makeRegistry({ maxEntries: 10, maxBytes: 1_000 });
    add(registry, 'r1', 100);
    registry.addBytes('r1', -500);
    expect(registry.totalBytes()).toBe(0);
  });

  it('ignores a delta for an unknown id', () => {
    const registry = makeRegistry();
    expect(registry.addBytes('nope', 100)).toBe(false);
    expect(registry.totalBytes()).toBe(0);
  });
});

describe('TTL', () => {
  it('drops an entry that has been idle past the TTL', () => {
    const registry = makeRegistry({ ttlMs: 60_000 });
    add(registry, 'r1');

    clock += 59_999;
    expect(registry.get('r1')).not.toBeNull();

    // A read counts as use, so the idle clock restarts from that read.
    clock += 60_001;
    expect(registry.get('r1')).toBeNull();
    expect(registry.has('r1')).toBe(false);
    expect(evictions).toEqual([{ resultId: 'r1', reason: 'expired' }]);
  });

  it('expires on the idle clock alone when nothing reads the entry', () => {
    const registry = makeRegistry({ ttlMs: 60_000 });
    add(registry, 'r1');
    clock += 60_001;
    expect(registry.has('r1')).toBe(false);
    expect(registry.size()).toBe(0);
    expect(evictions).toEqual([{ resultId: 'r1', reason: 'expired' }]);
  });

  it('treats access as resetting the idle clock', () => {
    const registry = makeRegistry({ ttlMs: 60_000 });
    add(registry, 'r1');
    for (let i = 0; i < 10; i += 1) {
      clock += 30_000;
      expect(registry.get('r1'), `tick ${i}`).not.toBeNull();
    }
    // Five minutes of steady use, and a 60s idle TTL never fired.
    expect(evictions).toEqual([]);
  });

  it('prunes every expired entry at once and reports how many went', () => {
    const registry = makeRegistry({ ttlMs: 1_000, maxEntries: 10 });
    add(registry, 'r1');
    add(registry, 'r2');
    clock += 500;
    add(registry, 'r3');
    clock += 600; // r1 and r2 are stale, r3 is not

    expect(registry.prune()).toBe(2);
    expect(registry.ids()).toEqual(['r3']);
    expect(evictions.map((e) => e.reason)).toEqual(['expired', 'expired']);
  });

  it('prunes nothing when the clock has not moved', () => {
    const registry = makeRegistry();
    add(registry, 'r1');
    expect(registry.prune()).toBe(0);
    expect(registry.has('r1')).toBe(true);
  });

  it('never expires with an infinite TTL', () => {
    const registry = makeRegistry({ ttlMs: Number.POSITIVE_INFINITY });
    add(registry, 'r1');
    clock += 10 ** 12;
    expect(registry.get('r1')).not.toBeNull();
  });
});

describe('explicit disposal', () => {
  it('reports whether delete removed anything, and frees the bytes', () => {
    const registry = makeRegistry();
    add(registry, 'r1', 300);
    expect(registry.delete('r1')).toBe(true);
    expect(registry.delete('r1')).toBe(false);
    expect(registry.size()).toBe(0);
    expect(registry.totalBytes()).toBe(0);
    expect(evictions).toEqual([{ resultId: 'r1', reason: 'disposed' }]);
  });

  it('drops every result for a connection when that connection is lost', () => {
    const registry = makeRegistry({ maxEntries: 10 });
    add(registry, 'r1', 10, 'conn-a');
    add(registry, 'r2', 10, 'conn-a');
    add(registry, 'r3', 10, 'conn-b');

    expect(registry.dropConnection('conn-a')).toBe(2);
    expect(registry.ids()).toEqual(['r3']);
    expect(registry.totalBytes()).toBe(10);
    expect(evictions.every((e) => e.reason === 'disposed')).toBe(true);
  });

  it('clears everything', () => {
    const registry = makeRegistry();
    add(registry, 'r1');
    add(registry, 'r2');
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.totalBytes()).toBe(0);
    expect(evictions).toHaveLength(2);
  });

  it('does not fire an eviction event when clearing an empty registry', () => {
    makeRegistry().clear();
    expect(evictions).toEqual([]);
  });
});

describe('clock independence', () => {
  it('never reads the wall clock, so tests and soak runs are reproducible', () => {
    const registry = makeRegistry({ ttlMs: 1_000 });
    add(registry, 'r1');
    // If the registry consulted Date.now() this would still be alive; the
    // injected clock has not moved, so the assertion below is about the injected
    // clock alone.
    expect(registry.get('r1')).not.toBeNull();
    clock += 1_001;
    expect(registry.get('r1')).toBeNull();
  });

  it('records the access time it observed', () => {
    const registry = makeRegistry();
    clock = 42;
    add(registry, 'r1');
    expect(registry.get('r1')?.lastAccess).toBe(42);
    clock = 99;
    expect(registry.get('r1')?.lastAccess).toBe(99);
  });
});
