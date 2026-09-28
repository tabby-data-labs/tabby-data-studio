/**
 * Custom scrollbar geometry (GRID-SPEC §5).
 *
 * A native scrollbar cannot represent 10M rows meaningfully, so the thumb is
 * computed here. Pure math, and it has an exact inverse — the round-trip
 * property at the bottom is what makes thumb dragging feel anchored instead of
 * drifting away from the pointer.
 */
import { describe, expect, it } from 'vitest';
import { scrollOffsetFromThumb, thumbGeometry } from '@/grid/scroll';

describe('thumbGeometry', () => {
  it('sizes the thumb proportionally to the visible fraction', () => {
    // 200 of 1000 visible on a 200px track -> 40px thumb
    expect(thumbGeometry(1000, 200, 0, 200)).toEqual({ offset: 0, size: 40 });
  });

  it('places the thumb at the far end when scrolled to the maximum', () => {
    const thumb = thumbGeometry(1000, 200, 800, 200);
    expect(thumb).toEqual({ offset: 160, size: 40 });
    // thumb must exactly fill the track at the end
    expect(thumb!.offset + thumb!.size).toBe(200);
  });

  it('is linear in the scroll offset', () => {
    expect(thumbGeometry(1000, 200, 400, 200)).toEqual({ offset: 80, size: 40 });
    expect(thumbGeometry(1000, 200, 200, 200)).toEqual({ offset: 40, size: 40 });
  });

  it('returns null when everything already fits', () => {
    expect(thumbGeometry(200, 200, 0, 200)).toBeNull();
    expect(thumbGeometry(100, 200, 0, 200)).toBeNull();
  });

  it('returns null for degenerate inputs', () => {
    expect(thumbGeometry(0, 200, 0, 200)).toBeNull();
    expect(thumbGeometry(1000, 0, 0, 200)).toBeNull();
    expect(thumbGeometry(1000, 200, 0, 0)).toBeNull();
    expect(thumbGeometry(1000, 200, 0, -5)).toBeNull();
    expect(thumbGeometry(-1, 200, 0, 200)).toBeNull();
  });

  it('clamps to a minimum thumb size so it stays grabbable', () => {
    const thumb = thumbGeometry(10_000_000, 100, 0, 100, 24);
    expect(thumb!.size).toBe(24);
    expect(thumb!.offset).toBe(0);
  });

  it('never lets the minimum exceed the track', () => {
    const thumb = thumbGeometry(10_000_000, 100, 5_000_000, 10, 24);
    expect(thumb!.size).toBe(10);
    expect(thumb!.offset).toBe(0);
  });

  it('clamps out-of-range scroll offsets', () => {
    expect(thumbGeometry(1000, 200, -100, 200)).toEqual({ offset: 0, size: 40 });
    expect(thumbGeometry(1000, 200, 99_999, 200)).toEqual({ offset: 160, size: 40 });
  });

  it('keeps the thumb inside the track at a 10M-row extent', () => {
    const content = 10_000_000 * 22;
    for (const offset of [0, 12_345, content / 2, content - 570]) {
      const thumb = thumbGeometry(content, 570, offset, 570, 24)!;
      expect(thumb.offset).toBeGreaterThanOrEqual(0);
      expect(thumb.offset + thumb.size).toBeLessThanOrEqual(570 + 1e-9);
      expect(thumb.size).toBeGreaterThanOrEqual(24);
    }
  });
});

describe('scrollOffsetFromThumb', () => {
  it('inverts the thumb position', () => {
    expect(scrollOffsetFromThumb(0, 40, 200, 1000, 200)).toBe(0);
    expect(scrollOffsetFromThumb(160, 40, 200, 1000, 200)).toBe(800);
    expect(scrollOffsetFromThumb(80, 40, 200, 1000, 200)).toBe(400);
  });

  it('returns zero when the thumb fills the track', () => {
    expect(scrollOffsetFromThumb(0, 200, 200, 1000, 200)).toBe(0);
    expect(scrollOffsetFromThumb(0, 10, 10, 1000, 100)).toBe(0);
  });

  it('clamps to the valid scroll range', () => {
    expect(scrollOffsetFromThumb(-50, 40, 200, 1000, 200)).toBe(0);
    expect(scrollOffsetFromThumb(9999, 40, 200, 1000, 200)).toBe(800);
  });

  it('round-trips with thumbGeometry', () => {
    const content = 10_000_000 * 22;
    const viewport = 570;
    for (const offset of [0, 1, 999, 123_456.75, content / 3, content - viewport]) {
      const thumb = thumbGeometry(content, viewport, offset, viewport, 24);
      expect(thumb).not.toBeNull();
      const back = scrollOffsetFromThumb(thumb!.offset, thumb!.size, viewport, content, viewport);
      expect(back).toBeCloseTo(offset, 3);
    }
  });
});
