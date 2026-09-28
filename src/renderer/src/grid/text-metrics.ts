/**
 * The structural subset of CanvasRenderingContext2D this module needs, so tests
 * can supply a deterministic fake. A real context satisfies it structurally.
 */
export interface MeasureContext {
  font: string;
  measureText(text: string): { width: number };
}

export interface FittedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly width: number;
}

export interface MetricsStats {
  /** Calls into measure(), i.e. per-cell text work requested by the painter. */
  readonly lookups: number;
  /** Calls that reached the underlying ctx.measureText, i.e. cache misses. */
  readonly misses: number;
}

const ELLIPSIS = '…';
const KEY_SEP = '\u0000';
/** Glyphs used to detect a monospace face; chosen for maximal width contrast. */
const MONO_PROBE_NARROW = 'i';
const MONO_PROBE_WIDE = 'W';

/**
 * Text measurement, with three tiers of cost.
 *
 * Measuring per cell per frame is the single most common canvas-grid performance
 * failure (GRID-SPEC §4), and a plain measurement cache is NOT enough: real
 * database columns are high-cardinality (ids, uuids, timestamps), so nearly
 * every string is new and the cache misses on almost every cell. Measured on the
 * Phase 1 benchmark, a cache-only implementation ran at a 96% miss rate and blew
 * the paint budget.
 *
 * So, cheapest first:
 *
 *  1. **Monospace arithmetic.** Two probes per font decide whether the face is
 *     monospace; if it is, width is exactly `text.length * charWidth` and no
 *     native measurement happens at all. Data grids essentially always use a
 *     monospace font, so this is the common path.
 *  2. **Measurement cache** for proportional faces, keyed on font + text.
 *  3. **Fit cache** for proportional faces, keyed on font + maxWidth + text,
 *     because `fit()` otherwise re-runs a binary search that allocates a fresh
 *     substring per probe.
 *
 * All three must be invalidated wholesale when the font or devicePixelRatio
 * changes — a stale entry produces subtly wrong ellipsis cut points that are
 * very hard to diagnose later.
 */
export class TextMetricsCache {
  private readonly cache = new Map<string, number>();
  private readonly fits = new Map<string, FittedText>();
  private readonly mono = new Map<string, number | null>();
  private lookups = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number = 10_000) {}

  get size(): number {
    return this.cache.size;
  }

  get fitSize(): number {
    return this.fits.size;
  }

  get stats(): MetricsStats {
    return { lookups: this.lookups, misses: this.misses };
  }

  resetStats(): void {
    this.lookups = 0;
    this.misses = 0;
  }

  /**
   * Character advance for a monospace face, or null if the face is proportional.
   * Costs two native measurements the first time a font is seen, then nothing.
   */
  private monoWidthFor(ctx: MeasureContext): number | null {
    const font = ctx.font;
    if (this.mono.has(font)) return this.mono.get(font) ?? null;

    const narrow = ctx.measureText(MONO_PROBE_NARROW).width;
    const wide = ctx.measureText(MONO_PROBE_WIDE).width;
    this.lookups += 2;
    this.misses += 2;

    const isMono = narrow > 0 && Math.abs(narrow - wide) < 0.01;
    const width = isMono ? narrow : null;
    this.mono.set(font, width);
    return width;
  }

  measure(ctx: MeasureContext, text: string): number {
    this.lookups += 1;

    const mono = this.monoWidthFor(ctx);
    if (mono !== null) return text.length * mono;

    const key = ctx.font + KEY_SEP + text;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // Re-insert so Map iteration order reflects recency (Map preserves
      // insertion order, and the first key is therefore the LRU victim).
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    this.misses += 1;
    const width = ctx.measureText(text).width;
    this.cache.set(key, width);
    this.evict(this.cache);
    return width;
  }

  /**
   * Largest prefix of `text` that fits in `maxWidth` once the ellipsis is
   * appended. Binary search over cached measurements, so a cold string costs
   * O(log n) and a repeated one costs a single hash lookup.
   */
  fit(ctx: MeasureContext, text: string, maxWidth: number): FittedText {
    // Under monospace arithmetic the search is already cheap, and caching it
    // would cost more in Map churn than it saves.
    if (this.monoWidthFor(ctx) !== null) return this.computeFit(ctx, text, maxWidth);

    const key = `${ctx.font}${KEY_SEP}${maxWidth}${KEY_SEP}${text}`;
    const cached = this.fits.get(key);
    if (cached !== undefined) {
      this.fits.delete(key);
      this.fits.set(key, cached);
      return cached;
    }

    const result = this.computeFit(ctx, text, maxWidth);
    this.fits.set(key, result);
    this.evict(this.fits);
    return result;
  }

  private computeFit(ctx: MeasureContext, text: string, maxWidth: number): FittedText {
    const full = this.measure(ctx, text);
    if (full <= maxWidth) return { text, truncated: false, width: full };

    const ellipsisWidth = this.measure(ctx, ELLIPSIS);
    if (ellipsisWidth > maxWidth) return { text: '', truncated: true, width: 0 };

    const budget = maxWidth - ellipsisWidth;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.measure(ctx, text.slice(0, mid)) <= budget) low = mid;
      else high = mid - 1;
    }

    const cut = text.slice(0, low);
    return { text: cut + ELLIPSIS, truncated: true, width: this.measure(ctx, cut) + ellipsisWidth };
  }

  private evict(map: Map<string, unknown>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  invalidate(): void {
    this.cache.clear();
    this.fits.clear();
    this.mono.clear();
  }
}
