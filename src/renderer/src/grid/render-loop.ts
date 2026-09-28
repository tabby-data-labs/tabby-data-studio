export interface FrameInfo {
  /** performance.now() at the start of the frame. */
  readonly now: number;
  /** Milliseconds since the previous rendered frame. */
  readonly dt: number;
}

export interface FrameStats {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly dropped: number;
  /** Per-cell text lookups requested by the painter. */
  readonly measureTextCalls: number;
  /** Of those, how many reached the underlying ctx.measureText. */
  readonly measureTextMisses: number;
}

const SAMPLE_LIMIT = 600;

/**
 * Dirty-flag render loop (GRID-SPEC §4).
 *
 * Nothing renders directly from an event handler: scroll, resize, selection and
 * data arrival all call `invalidate()`, and at most one rAF is in flight. That
 * is what keeps a trackpad's 120Hz event stream from producing 120 paints a
 * second, and what makes the frame budget measurable.
 */
export class RenderLoop {
  private readonly frame: (info: FrameInfo) => void;
  private dirty = false;
  private rafId = 0;
  private started = false;
  private last = 0;

  private readonly samples: number[] = [];
  private dropped = 0;
  private measureTextCalls = 0;
  private measureTextMisses = 0;

  constructor(frame: (info: FrameInfo) => void) {
    this.frame = frame;
  }

  get running(): boolean {
    return this.started;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  invalidate(): void {
    this.dirty = true;
    if (!this.started || this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.invalidate();
  }

  stop(): void {
    this.started = false;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Called by the paint pass so the budget can be asserted, not eyeballed. */
  recordMeasureText(lookups: number, misses: number): void {
    this.measureTextCalls += lookups;
    this.measureTextMisses += misses;
  }

  resetStats(): void {
    this.samples.length = 0;
    this.dropped = 0;
    this.measureTextCalls = 0;
    this.measureTextMisses = 0;
  }

  stats(): FrameStats {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return sorted[index] ?? 0;
    };
    return {
      frames: sorted.length,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      dropped: this.dropped,
      measureTextCalls: this.measureTextCalls,
      measureTextMisses: this.measureTextMisses,
    };
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    if (!this.started) return;

    if (this.dirty) {
      const dt = this.last === 0 ? 0 : now - this.last;
      this.last = now;
      this.dirty = false;

      const began = now;
      this.frame({ now, dt });
      const elapsed = performance.now() - began;

      this.samples.push(elapsed);
      if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
      // A frame that cost more than two vsync intervals dropped at least one.
      if (dt > 0 && dt > 33.4) this.dropped += 1;
    }

    // Re-arm if the frame itself invalidated (a block arrived mid-paint).
    if (this.dirty) this.rafId = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    this.stop();
    this.resetStats();
  }
}
