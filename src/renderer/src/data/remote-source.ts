/**
 * The IPC-backed `DataSource` that replaces `FakeDataSource` (PLAN Phase 5).
 *
 * The grid does not know this exists: it sees the same four members it has seen
 * since Phase 1, and Phase 5's exit criterion is that the grid's public API and
 * unit tests are byte-identical afterwards. Everything database-shaped stays on
 * this side of that line.
 *
 * What this class is *not* is a second windowing layer. `DataWindowController`
 * already owns prefetch, in-flight dedupe, priority and stale-abort, and it does
 * so with knowledge of the visible range that a `DataSource` does not have.
 * Duplicating any of it here would mean two components racing to decide what to
 * fetch. So `getBlock` is one honest request per call.
 *
 * What it does own is the thing the grid structurally cannot: **retry policy**.
 * `DataWindowController.request()` re-asks for any block that is neither cached
 * nor in flight, and `update()` runs every frame — so a range that keeps failing
 * would be re-requested 60 times a second forever. Against a server that has gone
 * away that is a retry storm the user can neither see nor stop. Backoff, attempt
 * limits and terminal states therefore live here.
 */
import type { ColumnMeta, EncodedRowBlock, ResultMeta, SortDirection } from '@shared/domain';
import type { Result, TabbyError } from '@shared/errors';
import type {
  ResultEvictionReason,
  ResultSortRequest,
  ResultWindowRequest,
} from '@shared/ipc-contract';
import { decodeBlock } from '@shared/columnar';
import type { DataSource, RowBlock } from '@/grid/types';

/** The slice of `window.tabby.db` this source needs. Narrow, so a fake is easy. */
export interface ResultBridge {
  resultWindow(req: ResultWindowRequest): Promise<Result<EncodedRowBlock>>;
  resultSort(req: ResultSortRequest): Promise<Result<ResultMeta>>;
  resultMeta(resultId: string): Promise<Result<ResultMeta>>;
}

/**
 * A state from which no amount of retrying can recover. Each one needs a different
 * sentence in the UI, and none of them should keep hitting the server.
 */
export type TerminalReason = 'evicted' | 'connection-lost' | 'cursor-closed' | 'cancelled';

export interface SourceState {
  /** Ranges currently recorded as failed (in backoff, or given up on). */
  readonly failedRanges: number;
  readonly lastError: TabbyError | null;
  readonly terminal: TerminalReason | null;
}

export interface RetryPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
}

/**
 * 250ms → 8s, five attempts. The base is well above one frame so a single failure
 * cannot become a per-frame request, and the cap keeps a retry from feeling like a
 * hang when the server comes back.
 */
export const DEFAULT_RETRY: RetryPolicy = { baseMs: 250, maxMs: 8_000, maxAttempts: 5 };

export type RemoteSourceErrorKind = 'aborted' | 'backoff' | 'terminal' | 'server';

/**
 * Rejections are typed rather than bare `Error`s because the three non-server kinds
 * must not be shown to the user: an aborted fetch is ordinary scrolling, and a
 * backoff rejection is the source *declining* to hammer a failing server.
 */
export class RemoteSourceError extends Error {
  readonly kind: RemoteSourceErrorKind;
  readonly error: TabbyError | null;

  constructor(kind: RemoteSourceErrorKind, message: string, error: TabbyError | null = null) {
    super(message);
    this.name = 'RemoteSourceError';
    this.kind = kind;
    this.error = error;
  }
}

/**
 * A `Map`, not an object literal: `TERMINAL['constructor']` on a plain object
 * would find `Object.prototype.constructor` and read a function as a terminal
 * reason. Error codes arrive from another process.
 */
const TERMINAL_CODES = new Map<string, TerminalReason>([
  ['RESULT_EVICTED', 'evicted'],
  ['RESULT_NOT_FOUND', 'evicted'],
  ['CURSOR_CLOSED', 'cursor-closed'],
  ['CONN_LOST', 'connection-lost'],
  ['QUERY_CANCELLED', 'cancelled'],
]);

const TERMINAL_MESSAGES: Readonly<Record<TerminalReason, string>> = {
  evicted: 'This result expired — re-run the query.',
  'connection-lost': 'The connection was lost — reconnect and re-run the query.',
  'cursor-closed': 'The server closed this result — re-run the query.',
  cancelled: 'This query was cancelled — re-run it to see results.',
};

/** Sentinel, so an abort is distinguishable from any error the bridge produces. */
const ABORTED = Symbol('aborted');

export interface RemoteSourceOptions {
  readonly resultId: string;
  readonly bridge: ResultBridge;
  readonly meta: ResultMeta;
  readonly now?: () => number;
  readonly retry?: Partial<RetryPolicy>;
  readonly onStateChange?: (state: SourceState) => void;
}

interface RangeFailure {
  readonly attempts: number;
  readonly retryAfter: number;
}

function rangeKey(startRow: number, rowCount: number): string {
  return `${startRow}:${rowCount}`;
}

/** The bridge contract is "never throws", but a missing channel would. Normalise. */
function asTabbyError(error: unknown): TabbyError {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as TabbyError).code === 'string' &&
    typeof (error as TabbyError).message === 'string'
  ) {
    return error as TabbyError;
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

function abortError(): RemoteSourceError {
  return new RemoteSourceError('aborted', 'the request was superseded');
}

/**
 * Rejects with `ABORTED` if the signal fires first.
 *
 * Electron's `invoke` cannot actually be cancelled, so the round trip still
 * completes; what matters is that its answer is thrown away rather than cached
 * over fresher data. `DataWindowController` drops superseded results too — this is
 * the second half of that, for callers that await `getBlock` directly (copy,
 * autofit).
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class RemoteDataSource implements DataSource {
  readonly resultId: string;

  private readonly bridge: ResultBridge;
  private readonly now: () => number;
  private readonly retry: RetryPolicy;
  private readonly onStateChange: ((state: SourceState) => void) | null;
  private readonly failures = new Map<string, RangeFailure>();

  private currentMeta: ResultMeta;
  private terminal: TerminalReason | null = null;
  private lastError: TabbyError | null = null;
  /** Signature of the last emitted state, so unchanged states stay silent. */
  private emitted = '';

  constructor(options: RemoteSourceOptions) {
    this.resultId = options.resultId;
    this.bridge = options.bridge;
    this.currentMeta = options.meta;
    this.now = options.now ?? (() => Date.now());
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.onStateChange = options.onStateChange ?? null;
    // Seeded rather than left empty: a source that has done nothing yet must not
    // announce itself on the first successful fetch.
    this.emitted = this.signature();
  }

  // ── DataSource ─────────────────────────────────────────────────────────────

  /**
   * Getters, not snapshots. The grid re-reads `rowCount` and `columns` on every
   * frame — for geometry, paint, the ARIA proxy and autofit — so a background
   * `count(*)` landing only has to update this object and call `invalidate()`.
   */
  get columns(): readonly ColumnMeta[] {
    return this.currentMeta.columns;
  }

  get rowCount(): number {
    return this.currentMeta.rowCount;
  }

  get rowCountIsEstimate(): boolean {
    return this.currentMeta.rowCountIsEstimate;
  }

  async getBlock(startRow: number, rowCount: number, signal: AbortSignal): Promise<RowBlock> {
    if (signal.aborted) throw abortError();
    if (this.terminal !== null) throw this.terminalError();

    const key = rangeKey(startRow, rowCount);
    const failure = this.failures.get(key);
    if (failure && this.now() < failure.retryAfter) {
      throw new RemoteSourceError(
        'backoff',
        `rows ${startRow}+${rowCount} are in backoff after ${failure.attempts} attempts`,
        this.lastError,
      );
    }

    let result: Result<EncodedRowBlock>;
    try {
      result = await raceAbort(
        this.bridge.resultWindow({ resultId: this.resultId, startRow, rowCount }),
        signal,
      );
    } catch (error) {
      // An abort is ordinary scrolling, not a failure: recording it would put a
      // retry banner up because the user scrolled quickly.
      if (error === ABORTED || signal.aborted) throw abortError();
      throw this.recordFailure(key, asTabbyError(error));
    }
    if (signal.aborted) throw abortError();

    if (result.ok) {
      this.clearFailures(key);
      return decodeBlock(result.value);
    }
    throw this.recordFailure(key, result.error);
  }

  /**
   * Server-side sort. Never a client-side reorder: the grid only ever holds a few
   * hundred rows of a possibly 10M-row result, so sorting locally would present a
   * confidently wrong answer.
   */
  async sort(columnIndex: number, direction: SortDirection | null): Promise<void> {
    if (this.terminal !== null) throw this.terminalError();

    const result = await this.bridge.resultSort({
      resultId: this.resultId,
      sort: direction === null ? null : { columnIndex, direction },
    });

    if (!result.ok) {
      const terminal = TERMINAL_CODES.get(result.error.code);
      if (terminal) this.setTerminal(terminal, result.error);
      throw new RemoteSourceError(
        terminal ? 'terminal' : 'server',
        result.error.message,
        result.error,
      );
    }

    this.currentMeta = result.value;
    // The failures described the previous ordering; carrying them over would leave
    // ranges in backoff that have never been asked for in this one.
    this.clearFailures(null);
  }

  // ── App-facing surface (not part of DataSource) ────────────────────────────

  get state(): SourceState {
    return {
      failedRanges: this.failures.size,
      lastError: this.lastError,
      terminal: this.terminal,
    };
  }

  /** A sentence for the banner, or null while the source is still usable. */
  get terminalMessage(): string | null {
    return this.terminal === null ? null : TERMINAL_MESSAGES[this.terminal];
  }

  /** Clears backoff so the next frame retries. A user action, never automatic. */
  retryFailed(): void {
    this.clearFailures(null);
  }

  /**
   * Re-reads the metadata, which is how the exact row count replaces the
   * `reltuples` estimate once main's background `count(*)` lands. A failure keeps
   * the estimate: an approximate scrollbar beats no scrollbar.
   */
  async refreshMeta(): Promise<void> {
    if (this.terminal !== null) return;
    const result = await this.bridge.resultMeta(this.resultId);
    if (!result.ok) return;
    this.currentMeta = result.value;
  }

  /** From `events.onResultEvicted`. Ignored when it names a different result. */
  markEvicted(reason: ResultEvictionReason, resultId: string = this.resultId): void {
    if (resultId !== this.resultId) return;
    this.setTerminal('evicted', {
      code: 'RESULT_EVICTED',
      message:
        reason === 'capacity'
          ? 'this result was evicted to free memory; re-run the query'
          : 'this result expired; re-run the query',
    });
  }

  /** From `events.onConnectionLost`. */
  markConnectionLost(): void {
    this.setTerminal('connection-lost', {
      code: 'CONN_LOST',
      message: 'the connection was lost',
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private terminalError(): RemoteSourceError {
    return new RemoteSourceError(
      'terminal',
      this.lastError?.message ?? this.terminalMessage ?? 'this result is no longer available',
      this.lastError,
    );
  }

  /** Always throws; typed `never` so callers can `throw this.recordFailure(…)`. */
  private recordFailure(key: string, error: TabbyError): never {
    const terminal = TERMINAL_CODES.get(error.code);
    if (terminal !== undefined) {
      this.setTerminal(terminal, error);
      throw this.terminalError();
    }

    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const exhausted = attempts >= this.retry.maxAttempts;
    const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempts - 1));
    this.failures.set(key, {
      attempts,
      // Infinity rather than a far-future timestamp: a given-up range must stay
      // given up even if the session outlives every plausible backoff.
      retryAfter: exhausted ? Number.POSITIVE_INFINITY : this.now() + backoff,
    });

    this.lastError = error;
    this.emitState();
    throw new RemoteSourceError('server', error.message, error);
  }

  /** `key === null` clears every range. */
  private clearFailures(key: string | null): void {
    if (key === null) this.failures.clear();
    else this.failures.delete(key);
    this.lastError = null;
    this.emitState();
  }

  private setTerminal(reason: TerminalReason, error: TabbyError): void {
    if (this.terminal !== null) return;
    this.terminal = reason;
    this.lastError = error;
    // Per-range bookkeeping is meaningless once nothing can be fetched at all, and
    // leaving it up would show "3 ranges failed" next to a terminal banner.
    this.failures.clear();
    this.emitState();
  }

  private signature(): string {
    return `${this.failures.size}|${this.terminal ?? ''}|${this.lastError?.code ?? ''}`;
  }

  private emitState(): void {
    const signature = this.signature();
    if (signature === this.emitted) return;
    this.emitted = signature;
    this.onStateChange?.(this.state);
  }
}
