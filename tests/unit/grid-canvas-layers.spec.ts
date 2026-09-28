// @vitest-environment happy-dom
/**
 * Tier 2 (AGENTS.md): canvas layer plumbing, written after the implementation.
 *
 * happy-dom has no canvas backend, so getContext is stubbed with the recording
 * context. `create-data-grid` is deliberately NOT tested here — it needs
 * ResizeObserver, matchMedia, pointer capture and a real compositor, and mocking
 * all of that would assert nothing worth knowing. It is instead exercised for
 * real by `npm run smoke` (mounts, paints pixels, no console errors) and
 * `npm run bench` (600 measured frames).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasLayers } from '@/grid/canvas-layers';
import { createRecordingCtx } from './helpers/recording-ctx';

interface MediaStub {
  listeners: (() => void)[];
  fire(): void;
}

let media: MediaStub;
/** Every context handed out, in layer creation order, so calls can be asserted. */
let contexts: ReturnType<typeof createRecordingCtx>[];

function stubCanvasContext(): void {
  contexts = [];
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: () => unknown;
  };
  proto.getContext = (): unknown => {
    const recording = createRecordingCtx();
    contexts.push(recording);
    return recording.ctx;
  };
}

function stubMatchMedia(): void {
  media = {
    listeners: [],
    fire() {
      for (const listener of [...this.listeners]) listener();
    },
  };
  window.matchMedia = vi.fn(() => ({
    addEventListener: (_event: string, handler: () => void) => media.listeners.push(handler),
    removeEventListener: (_event: string, handler: () => void) => {
      media.listeners = media.listeners.filter((entry) => entry !== handler);
    },
  })) as unknown as typeof window.matchMedia;
}

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  stubCanvasContext();
  stubMatchMedia();
  document.body.innerHTML = '';
});

describe('layer construction', () => {
  it('creates exactly five canvases in paint order', () => {
    const layers = new CanvasLayers(makeHost());
    const canvases = layers.root.querySelectorAll('canvas');
    expect(canvases).toHaveLength(5);
    // body first so headers and the overlay stack above it
    expect(layers.layer('body').canvas).toBe(canvases[0]);
    expect(layers.layer('overlay').canvas).toBe(canvases[4]);
  });

  it('makes every canvas click-through so pointer coords stay host-relative', () => {
    const layers = new CanvasLayers(makeHost());
    for (const canvas of layers.root.querySelectorAll('canvas')) {
      expect(canvas.style.pointerEvents).toBe('none');
    }
  });

  it('hides every canvas from assistive tech', () => {
    const layers = new CanvasLayers(makeHost());
    for (const canvas of layers.root.querySelectorAll('canvas')) {
      expect(canvas.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('makes the root focusable for keyboard handling', () => {
    const layers = new CanvasLayers(makeHost());
    expect(layers.root.tabIndex).toBe(0);
  });

  it('throws a clear error when a 2d context is unavailable', () => {
    const proto = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
    const previous = proto.getContext;
    proto.getContext = (): unknown => null;
    try {
      expect(() => new CanvasLayers(makeHost())).toThrow(/canvas 2d context unavailable/);
    } finally {
      proto.getContext = previous;
    }
  });
});

describe('resize and HiDPI', () => {
  it('scales backing stores by devicePixelRatio but keeps CSS size in pixels', () => {
    const layers = new CanvasLayers(makeHost());
    layers.resize(800, 600, 50, 30, 2);

    const body = layers.layer('body');
    expect(body.canvas.width).toBe((800 - 50) * 2);
    expect(body.canvas.height).toBe((600 - 30) * 2);
    expect(body.canvas.style.width).toBe('750px');
    expect(body.canvas.style.height).toBe('570px');
  });

  it('computes the four header/body regions from the origins', () => {
    const layers = new CanvasLayers(makeHost());
    layers.resize(800, 600, 50, 30, 1);

    expect(layers.region('corner')).toEqual({ x: 0, y: 0, width: 50, height: 30 });
    expect(layers.region('colHeader')).toEqual({ x: 50, y: 0, width: 750, height: 30 });
    expect(layers.region('rowHeader')).toEqual({ x: 0, y: 30, width: 50, height: 570 });
    expect(layers.region('body')).toEqual({ x: 50, y: 30, width: 750, height: 570 });
    // full-bleed so a resize guide can span header and body
    expect(layers.region('overlay')).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('positions each layer at its region origin', () => {
    const layers = new CanvasLayers(makeHost());
    layers.resize(800, 600, 50, 30, 1);
    const rowHeader = layers.layer('rowHeader');
    expect(rowHeader.canvas.style.left).toBe('0px');
    expect(rowHeader.canvas.style.top).toBe('30px');
    const colHeader = layers.layer('colHeader');
    expect(colHeader.canvas.style.left).toBe('50px');
    expect(colHeader.canvas.style.top).toBe('0px');
  });

  it('never produces a zero or negative backing store', () => {
    const layers = new CanvasLayers(makeHost());
    // viewport smaller than the header and row-header widths
    layers.resize(10, 10, 50, 30, 1);
    for (const name of ['body', 'colHeader', 'rowHeader', 'corner'] as const) {
      expect(layers.layer(name).canvas.width).toBeGreaterThanOrEqual(1);
      expect(layers.layer(name).canvas.height).toBeGreaterThanOrEqual(1);
    }
    expect(layers.region('body').width).toBe(0);
  });

  it('re-applies the DPR transform on every resize, since canvas.width resets it', () => {
    const layers = new CanvasLayers(makeHost());
    layers.resize(800, 600, 50, 30, 2);

    // LAYER_ORDER puts body first, so contexts[0] is the body layer.
    const body = contexts[0];
    expect(body).toBeDefined();
    const transforms = (): unknown[][] =>
      body!.calls.filter((call) => call.method === 'setTransform').map((call) => [...call.args]);

    expect(transforms()).toEqual([[2, 0, 0, 2, 0, 0]]);

    // Assigning canvas.width clears the context transform, so a second resize
    // must re-apply it or the canvas renders at 1x and looks blurry.
    layers.resize(800, 600, 50, 30, 2);
    expect(transforms()).toHaveLength(2);

    // A DPR change (monitor switch) must scale by the new ratio.
    layers.resize(800, 600, 50, 30, 1);
    expect(transforms().at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(layers.devicePixelRatio).toBe(1);
  });
});

describe('devicePixelRatio watching', () => {
  it('arms a resolution media query', () => {
    const layers = new CanvasLayers(makeHost());
    layers.watchDpr(() => {});
    expect(window.matchMedia).toHaveBeenCalled();
    expect(media.listeners).toHaveLength(1);
  });

  it('re-arms after a change, because a MediaQueryList is bound to one value', () => {
    const layers = new CanvasLayers(makeHost());
    const onChange = vi.fn();
    layers.watchDpr(onChange);
    expect(media.listeners).toHaveLength(1);

    media.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(media.listeners).toHaveLength(1);

    media.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('stops listening once disposed', () => {
    const layers = new CanvasLayers(makeHost());
    const dispose = layers.watchDpr(() => {});
    dispose();
    expect(media.listeners).toHaveLength(0);
    media.fire();
  });
});

describe('destroy', () => {
  it('removes the root from the host and drops the DPR watcher', () => {
    const host = makeHost();
    const layers = new CanvasLayers(host);
    layers.watchDpr(() => {});
    expect(host.querySelector('.grid-root')).not.toBeNull();

    layers.destroy();
    expect(host.querySelector('.grid-root')).toBeNull();
    expect(media.listeners).toHaveLength(0);
  });

  it('is safe to call twice', () => {
    const layers = new CanvasLayers(makeHost());
    layers.destroy();
    expect(() => layers.destroy()).not.toThrow();
  });
});
