/**
 * The bounded result registry (PLAN Phase 4, ARCHITECTURE §5.3).
 *
 * `resultId` → live cursor state plus column metadata. The bounds are the
 * feature: an unbounded registry holds server-side cursors open, each of which
 * pins an xmin horizon and stops vacuum reclaiming dead tuples on somebody's
 * production database. Count, idle TTL and total bytes are all capped, and every
 * eviction is reported so the renderer can say "result expired — re-run query"
 * instead of showing blank cells.
 *
 * The clock is injected. Nothing here reads `Date.now()`, which is what makes the
 * TTL and the soak behaviour testable in microseconds instead of minutes.
 */

export type EvictionReason = 'capacity' | 'expired' | 'disposed';

export interface ResultEntry<T> {
  readonly resultId: string;
  readonly connectionId: string;
  readonly payload: T;
  readonly bytesHeld: number;
  readonly lastAccess: number;
  readonly createdAt: number;
}

export interface NewResult<T> {
  readonly resultId: string;
  readonly connectionId: string;
  readonly payload: T;
  readonly bytesHeld: number;
}

export interface ResultRegistryOptions<T> {
  /** Hard cap on concurrent live results. */
  readonly maxEntries: number;
  /** Idle time after which a result is dropped. `Infinity` disables expiry. */
  readonly ttlMs: number;
  /** Hard cap on the summed `bytesHeld` of live results. */
  readonly maxBytes: number;
  readonly now?: () => number;
  readonly onEvict?: (entry: ResultEntry<T>, reason: EvictionReason) => void;
}

interface LiveEntry<T> {
  resultId: string;
  connectionId: string;
  payload: T;
  bytesHeld: number;
  lastAccess: number;
  createdAt: number;
}

export class RegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryConfigError';
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RegistryConfigError(`${name} must be a positive integer`);
  }
  return value;
}

export class ResultRegistry<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly onEvict: ((entry: ResultEntry<T>, reason: EvictionReason) => void) | null;

  /** Insertion-ordered, and re-inserted on access, so iteration order is LRU order. */
  private readonly entries = new Map<string, LiveEntry<T>>();
  private bytes = 0;

  constructor(options: ResultRegistryOptions<T>) {
    this.maxEntries = positiveInteger(options.maxEntries, 'maxEntries');
    this.maxBytes =
      typeof options.maxBytes === 'number' &&
      Number.isFinite(options.maxBytes) &&
      options.maxBytes > 0
        ? options.maxBytes
        : throwConfig('maxBytes must be a positive, finite number of bytes');
    // Zero TTL would evict a result the instant it was created, so "never expire"
    // has to be asked for explicitly as Infinity.
    this.ttlMs =
      typeof options.ttlMs === 'number' && options.ttlMs > 0
        ? options.ttlMs
        : throwConfig('ttlMs must be positive, or Infinity to disable expiry');
    this.now = options.now ?? (() => Date.now());
    this.onEvict = options.onEvict ?? null;
  }

  size(): number {
    return this.entries.size;
  }

  /** Sum of `bytesHeld` over the live entries — the figure the memory cap enforces. */
  totalBytes(): number {
    return this.bytes;
  }

  /** Insertion order, oldest first. */
  ids(): readonly string[] {
    return [...this.entries.keys()];
  }

  idsForConnection(connectionId: string): readonly string[] {
    const ids: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.connectionId === connectionId) ids.push(entry.resultId);
    }
    return ids;
  }

  /**
   * Stores a result. Returns false when it could never fit, in which case
   * nothing else is evicted — dropping the whole registry to hold one oversized
   * result would be worse than refusing it.
   */
  set(input: NewResult<T>): boolean {
    const bytesHeld = Number.isFinite(input.bytesHeld) ? Math.max(0, input.bytesHeld) : 0;
    if (bytesHeld > this.maxBytes) return false;

    this.makeRoomFor(input.resultId, bytesHeld);

    const now = this.now();
    const existing = this.entries.get(input.resultId);
    if (existing) {
      this.bytes -= existing.bytesHeld;
      this.entries.delete(input.resultId);
    }

    // Re-inserted rather than mutated in place, so the entry moves to the back of
    // the LRU order.
    this.entries.set(input.resultId, {
      resultId: input.resultId,
      connectionId: input.connectionId,
      payload: input.payload,
      bytesHeld,
      lastAccess: now,
      createdAt: existing?.createdAt ?? now,
    });
    this.bytes += bytesHeld;
    return true;
  }

  /**
   * Reads a result and counts it as recent use.
   *
   * Returns null for an unknown *or* expired id — the two are indistinguishable
   * to the caller, and both mean "re-run the query".
   */
  get(resultId: string): ResultEntry<T> | null {
    const found = this.live(resultId);
    if (!found) return null;
    found.lastAccess = this.now();
    this.entries.delete(resultId);
    this.entries.set(resultId, found);
    return snapshot(found);
  }

  /** Membership test. Drops an expired entry but does not count as use. */
  has(resultId: string): boolean {
    return this.live(resultId) !== null;
  }

  /**
   * Accounts for bytes a result has grown by, typically because it cached another
   * block. Evicts other results if the cap is breached.
   */
  addBytes(resultId: string, delta: number): boolean {
    const found = this.live(resultId);
    if (!found || !Number.isFinite(delta)) return false;

    const before = found.bytesHeld;
    const after = Math.max(0, before + delta);
    found.bytesHeld = after;
    this.bytes = Math.max(0, this.bytes + (after - before));
    this.enforceCap(resultId);
    return true;
  }

  /** Removes one result. Returns false when it was not there. */
  delete(resultId: string): boolean {
    const found = this.entries.get(resultId);
    if (!found) return false;
    this.remove(found, this.isExpired(found) ? 'expired' : 'disposed');
    return true;
  }

  /** Removes every result belonging to a connection, e.g. after it was lost. */
  dropConnection(connectionId: string): number {
    let dropped = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.connectionId === connectionId) {
        this.remove(entry, 'disposed');
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Drops everything that has been idle past the TTL. Returns how many went. */
  prune(): number {
    let dropped = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.isExpired(entry)) {
        this.remove(entry, 'expired');
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry, 'disposed');
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The entry if it exists and has not expired; drops it if it has. */
  private live(resultId: string): LiveEntry<T> | null {
    const found = this.entries.get(resultId);
    if (!found) return null;
    if (this.isExpired(found)) {
      this.remove(found, 'expired');
      return null;
    }
    return found;
  }

  private isExpired(entry: LiveEntry<T>): boolean {
    return this.now() - entry.lastAccess > this.ttlMs;
  }

  /**
   * Bookkeeping happens before the callback, so a listener that throws cannot
   * leave the byte total disagreeing with the live entries.
   */
  private remove(entry: LiveEntry<T>, reason: EvictionReason): void {
    this.entries.delete(entry.resultId);
    this.bytes = Math.max(0, this.bytes - entry.bytesHeld);
    this.onEvict?.(snapshot(entry), reason);
  }

  private oldestOtherThan(resultId: string): LiveEntry<T> | null {
    for (const entry of this.entries.values()) {
      if (entry.resultId !== resultId) return entry;
    }
    return null;
  }

  private bytesOtherThan(resultId: string): number {
    const own = this.entries.get(resultId)?.bytesHeld ?? 0;
    return Math.max(0, this.bytes - own);
  }

  private countOtherThan(resultId: string): number {
    return this.entries.has(resultId) ? this.entries.size - 1 : this.entries.size;
  }

  private enforceCap(protect: string): void {
    while (
      this.bytesOtherThan(protect) + (this.entries.get(protect)?.bytesHeld ?? 0) >
      this.maxBytes
    ) {
      const victim = this.oldestOtherThan(protect);
      if (!victim) return;
      this.remove(victim, 'capacity');
    }
  }

  private makeRoomFor(resultId: string, incomingBytes: number): void {
    while (this.bytesOtherThan(resultId) + incomingBytes > this.maxBytes) {
      const victim = this.oldestOtherThan(resultId);
      if (!victim) return;
      this.remove(victim, 'capacity');
    }
    while (this.countOtherThan(resultId) + 1 > this.maxEntries) {
      const victim = this.oldestOtherThan(resultId);
      if (!victim) return;
      this.remove(victim, 'capacity');
    }
  }
}

function snapshot<T>(entry: LiveEntry<T>): ResultEntry<T> {
  return {
    resultId: entry.resultId,
    connectionId: entry.connectionId,
    payload: entry.payload,
    bytesHeld: entry.bytesHeld,
    lastAccess: entry.lastAccess,
    createdAt: entry.createdAt,
  };
}

function throwConfig(message: string): never {
  throw new RegistryConfigError(message);
}
