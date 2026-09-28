/**
 * GRID-SPEC §4: text measurement and fit() cut points.
 *
 * Two paths are covered because they have different cost profiles:
 *  - a **monospace** face, where width is arithmetic and no native measurement
 *    happens after a two-probe detection;
 *  - a **proportional** face, which falls back to the LRU measurement cache and
 *    the fit cache.
 *
 * Only the monospace path is what this grid actually uses; the proportional path
 * exists so the optimisation degrades correctly instead of silently producing
 * wrong ellipses for a future theme that uses a proportional UI font.
 */
import { describe, expect, it, vi } from 'vitest';
import { TextMetricsCache } from '@/grid/text-metrics';
import type { MeasureContext } from '@/grid/text-metrics';

/** Uniform advance per glyph, so it is detected as monospace. */
function monoCtx(charWidth = 6): MeasureContext & { calls: number } {
  const state = { calls: 0, font: '12px mono' };
  return {
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get calls() {
      return state.calls;
    },
    measureText(text: string) {
      state.calls += 1;
      return { width: text.length * charWidth };
    },
  } as MeasureContext & { calls: number };
}

/** Per-glyph widths, with 'i' and 'W' deliberately unequal so detection fails. */
function proportionalCtx(scale = 1): MeasureContext & { calls: number } {
  const widths: Record<string, number> = { i: 3, W: 12, '…': 6 };
  const state = { calls: 0, font: '12px sans' };
  return {
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get calls() {
      return state.calls;
    },
    measureText(text: string) {
      state.calls += 1;
      let total = 0;
      for (const char of text) total += (widths[char] ?? 6) * scale;
      return { width: total };
    },
  } as MeasureContext & { calls: number };
}

describe('monospace fast path', () => {
  it('detects the face with two probes and then never measures again', () => {
    const ctx = monoCtx(6);
    const cache = new TextMetricsCache();
    expect(cache.measure(ctx, 'hello')).toBe(30);
    expect(ctx.calls).toBe(2);

    // Distinct, never-before-seen strings still cost zero native calls.
    expect(cache.measure(ctx, 'a-completely-different-value')).toBe(28 * 6);
    expect(cache.measure(ctx, '9007199254740993')).toBe(16 * 6);
    expect(ctx.calls).toBe(2);
  });

  it('is exact for the empty string', () => {
    const ctx = monoCtx(6);
    expect(new TextMetricsCache().measure(ctx, '')).toBe(0);
  });

  it('re-detects when the font changes', () => {
    const ctx = monoCtx(6);
    const cache = new TextMetricsCache();
    cache.measure(ctx, 'x');
    expect(ctx.calls).toBe(2);

    ctx.font = 'bold 12px mono';
    cache.measure(ctx, 'x');
    expect(ctx.calls).toBe(4);
  });

  it('re-detects after invalidate()', () => {
    const ctx = monoCtx(6);
    const cache = new TextMetricsCache();
    cache.measure(ctx, 'x');
    cache.invalidate();
    cache.measure(ctx, 'x');
    expect(ctx.calls).toBe(4);
  });

  it('reports lookups without reporting misses', () => {
    const ctx = monoCtx(6);
    const cache = new TextMetricsCache();
    for (let i = 0; i < 500; i += 1) cache.measure(ctx, `row-${i}`);
    // 500 lookups, but only the 2 detection probes touched the real context.
    expect(cache.stats.lookups).toBe(502);
    expect(cache.stats.misses).toBe(2);
  });
});

describe('proportional fallback: measure()', () => {
  it('measures once and serves repeats from the cache', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    expect(cache.measure(ctx, 'hello')).toBe(30);
    const settled = ctx.calls; // 2 detection probes + 1 measurement
    expect(settled).toBe(3);

    cache.measure(ctx, 'hello');
    cache.measure(ctx, 'hello');
    expect(ctx.calls).toBe(settled);
  });

  it('keys on font, so the same text under two fonts is two entries', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    cache.measure(ctx, 'abc');
    ctx.font = '24px sans';
    cache.measure(ctx, 'abc');
    expect(cache.size).toBe(2);
  });

  it('evicts the least recently used entry past capacity', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache(2);
    cache.measure(ctx, 'a');
    cache.measure(ctx, 'b');

    // Touch 'a' so 'b' becomes the LRU victim.
    cache.measure(ctx, 'a');
    const afterTouch = ctx.calls;

    cache.measure(ctx, 'c');
    expect(cache.size).toBe(2);
    expect(ctx.calls).toBe(afterTouch + 1);

    // 'b' was evicted, so it costs a measurement again.
    cache.measure(ctx, 'b');
    const afterB = ctx.calls;
    expect(afterB).toBe(afterTouch + 2);

    // 'c' survived and is free.
    cache.measure(ctx, 'c');
    expect(ctx.calls).toBe(afterB);
  });

  it('drops every entry on invalidate()', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    cache.measure(ctx, 'abc');
    const before = ctx.calls;
    cache.invalidate();
    expect(cache.size).toBe(0);
    cache.measure(ctx, 'abc');
    // invalidate also drops monospace detection, so this re-pays the 2 probes
    // plus the measurement itself.
    expect(ctx.calls).toBe(before + 3);
  });
});

describe('fit() — monospace arithmetic', () => {
  it('returns text unchanged when it already fits', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    expect(cache.fit(ctx, 'abc', 100)).toEqual({ text: 'abc', truncated: false, width: 18 });
  });

  it('returns text unchanged when it fits exactly', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    // 'abcdef' = 36px
    expect(cache.fit(ctx, 'abcdef', 36)).toEqual({ text: 'abcdef', truncated: false, width: 36 });
  });

  it('cuts at the largest prefix that leaves room for the ellipsis', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    // budget = 60 - 6 (ellipsis) = 54 -> 9 chars
    expect(cache.fit(ctx, 'abcdefghijklmnop', 60)).toEqual({
      text: 'abcdefghi…',
      truncated: true,
      width: 60,
    });
  });

  it('never exceeds maxWidth', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    for (const maxWidth of [7, 13, 19, 61, 121, 999]) {
      const result = cache.fit(ctx, 'the quick brown fox jumps', maxWidth);
      expect(result.width, `maxWidth ${maxWidth}`).toBeLessThanOrEqual(maxWidth);
    }
  });

  it('yields an empty string when even the ellipsis does not fit', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    expect(cache.fit(ctx, 'abcdef', 5)).toEqual({ text: '', truncated: true, width: 0 });
    expect(cache.fit(ctx, 'abcdef', 0)).toEqual({ text: '', truncated: true, width: 0 });
    expect(cache.fit(ctx, 'abcdef', -10)).toEqual({ text: '', truncated: true, width: 0 });
  });

  it('reports the empty string as fitting, not truncated', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    expect(cache.fit(ctx, '', 10)).toEqual({ text: '', truncated: false, width: 0 });
    expect(cache.fit(ctx, '', 0)).toEqual({ text: '', truncated: false, width: 0 });
  });

  it('is idempotent', () => {
    const ctx = monoCtx();
    const cache = new TextMetricsCache();
    const once = cache.fit(ctx, 'a-very-long-column-value', 40);
    const twice = cache.fit(ctx, once.text, 40);
    expect(twice.text).toBe(once.text);
    expect(twice.width).toBe(once.width);
  });

  it('handles a single-character budget', () => {
    const ctx = monoCtx(1);
    const cache = new TextMetricsCache();
    // every glyph is 1px, ellipsis is 1px: budget = 3 - 1 = 2 chars
    expect(cache.fit(ctx, 'abcdef', 3)).toEqual({ text: 'ab…', truncated: true, width: 3 });
  });
});

describe('fit() — proportional fallback', () => {
  it('produces the same cut semantics as the monospace path', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    // 'oooooooooo' = 10 * 6 = 60px; budget 60 - 6 = 54 -> 9 chars
    expect(cache.fit(ctx, 'oooooooooooooooo', 60)).toEqual({
      text: 'ooooooooo…',
      truncated: true,
      width: 60,
    });
  });

  it('serves a repeated fit from the fit cache', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    cache.fit(ctx, 'some-repeated-enum-value', 80);
    expect(cache.fitSize).toBe(1);
    const before = ctx.calls;
    cache.fit(ctx, 'some-repeated-enum-value', 80);
    expect(ctx.calls).toBe(before);
  });

  it('distinguishes the same text at different widths', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    cache.fit(ctx, 'abcdefghij', 40);
    cache.fit(ctx, 'abcdefghij', 60);
    expect(cache.fitSize).toBe(2);
  });

  it('never exceeds maxWidth', () => {
    const ctx = proportionalCtx();
    const cache = new TextMetricsCache();
    for (const maxWidth of [7, 13, 19, 61, 121]) {
      const result = cache.fit(ctx, 'the quick brown fox jumps', maxWidth);
      expect(result.width, `maxWidth ${maxWidth}`).toBeLessThanOrEqual(maxWidth);
    }
  });
});

describe('integration with a real-shaped context', () => {
  it('accepts any object satisfying the minimal measure interface', () => {
    const measureText = vi.fn((text: string) => ({ width: text.length * 10 }));
    const ctx = { font: '13px sans', measureText } as unknown as MeasureContext;
    const cache = new TextMetricsCache();
    expect(cache.measure(ctx, 'abcd')).toBe(40);
    expect(cache.measure(ctx, 'abcd')).toBe(40);
    // uniform advance -> detected monospace -> only the 2 detection probes
    expect(measureText).toHaveBeenCalledTimes(2);
  });
});
