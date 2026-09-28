// @vitest-environment happy-dom
/**
 * The dirty-flag render loop (GRID-SPEC §4).
 *
 * The invariant that matters: nothing renders directly from an event handler,
 * and at most one rAF is in flight. Without coalescing, a 120Hz trackpad would
 * drive 120 paints a second and blow the frame budget.
 */
import { describe, expect, it } from 'vitest';
import { RenderLoop } from '@/grid/render-loop';

/** Resolves after the next animation frame has had a chance to run. */
function nextFrames(count = 2): Promise<void> {
  let remaining = count;
  return new Promise<void>((resolve) => {
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

describe('lifecycle', () => {
  it('does not render before start()', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
    });
    loop.invalidate();
    await nextFrames();
    expect(frames).toBe(0);
    expect(loop.running).toBe(false);
  });

  it('renders once after start()', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
    });
    loop.start();
    expect(loop.running).toBe(true);
    await nextFrames(3);
    expect(frames).toBe(1);
    loop.destroy();
  });

  it('stops rendering after stop()', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
    });
    loop.start();
    await nextFrames(3);
    loop.stop();
    const settled = frames;
    loop.invalidate();
    await nextFrames(3);
    expect(frames).toBe(settled);
    expect(loop.running).toBe(false);
  });

  it('is safe to start and destroy repeatedly', async () => {
    const loop = new RenderLoop(() => {});
    loop.start();
    loop.start();
    loop.destroy();
    loop.destroy();
    await nextFrames();
    expect(loop.running).toBe(false);
  });
});

describe('coalescing', () => {
  it('collapses many invalidations in one frame into a single paint', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
    });
    loop.start();
    await nextFrames(3);
    expect(frames).toBe(1);

    // A trackpad emits dozens of scroll events per frame; all of them invalidate.
    for (let i = 0; i < 50; i += 1) loop.invalidate();
    await nextFrames(3);
    expect(frames).toBe(2);
    loop.destroy();
  });

  it('does not paint again when nothing was invalidated', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
    });
    loop.start();
    await nextFrames(6);
    expect(frames).toBe(1);
    expect(loop.isDirty).toBe(false);
    loop.destroy();
  });

  it('re-arms when a frame invalidates itself, as a data arrival would', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
      // Simulate a block landing mid-paint and requesting another pass.
      if (frames < 3) loop.invalidate();
    });
    loop.start();
    await nextFrames(8);
    expect(frames).toBe(3);
    loop.destroy();
  });
});

describe('frame statistics', () => {
  it('reports zeros before any frame has run', () => {
    const loop = new RenderLoop(() => {});
    const stats = loop.stats();
    expect(stats.frames).toBe(0);
    expect(stats.p50).toBe(0);
    expect(stats.p95).toBe(0);
    expect(stats.dropped).toBe(0);
    expect(stats.measureTextCalls).toBe(0);
    expect(stats.measureTextMisses).toBe(0);
  });

  it('counts frames and accumulates the measurement counters', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
      loop.recordMeasureText(500, 3);
      if (frames < 4) loop.invalidate();
    });
    loop.start();
    await nextFrames(10);

    const stats = loop.stats();
    expect(stats.frames).toBe(4);
    expect(stats.measureTextCalls).toBe(2000);
    expect(stats.measureTextMisses).toBe(12);
    loop.destroy();
  });

  it('orders percentiles monotonically and clears on reset', async () => {
    let frames = 0;
    const loop = new RenderLoop(() => {
      frames += 1;
      // Burn a measurable amount of time so the percentiles are non-zero.
      const until = performance.now() + 1.5;
      while (performance.now() < until) {
        /* busy wait */
      }
      if (frames < 12) loop.invalidate();
    });
    loop.start();
    await nextFrames(30);

    const stats = loop.stats();
    expect(stats.frames).toBe(12);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThanOrEqual(stats.p50);
    expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);

    loop.resetStats();
    expect(loop.stats().frames).toBe(0);
    expect(loop.stats().measureTextCalls).toBe(0);
    loop.destroy();
  });

  it('passes a monotonically increasing timestamp to the frame callback', async () => {
    const stamps: number[] = [];
    let frames = 0;
    const loop = new RenderLoop((info) => {
      stamps.push(info.now);
      frames += 1;
      if (frames < 3) loop.invalidate();
    });
    loop.start();
    await nextFrames(8);
    expect(stamps).toHaveLength(3);
    expect(stamps[1]!).toBeGreaterThanOrEqual(stamps[0]!);
    expect(stamps[2]!).toBeGreaterThanOrEqual(stamps[1]!);
    loop.destroy();
  });
});
