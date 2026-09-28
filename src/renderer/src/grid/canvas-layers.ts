import type { PaintContext } from './paint';

export type LayerName = 'corner' | 'colHeader' | 'rowHeader' | 'body' | 'overlay';

export interface Layer {
  readonly name: LayerName;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: PaintContext;
}

interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LAYER_ORDER: readonly LayerName[] = ['body', 'rowHeader', 'colHeader', 'corner', 'overlay'];

/**
 * Five stacked canvases (GRID-SPEC §2).
 *
 * Splitting them is the core performance decision: scrolling repaints `body`
 * only, so headers are never redrawn, and a rubber-band drag repaints `overlay`
 * only, so 30k cells are never redrawn for a selection change.
 *
 * All canvases have `pointer-events: none`; listeners live on `root`, which
 * makes pointer coordinates host-relative and matches what `hitTest` expects.
 */
export class CanvasLayers {
  readonly root: HTMLDivElement;

  private readonly layers = new Map<LayerName, Layer>();
  private readonly regions = new Map<LayerName, Region>();
  private dpr = 1;
  private width = 0;
  private height = 0;
  private originX = 0;
  private originY = 0;
  private disposeDprWatch: (() => void) | null = null;

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'grid-root';
    root.style.position = 'relative';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.overflow = 'hidden';
    root.style.contain = 'strict';
    root.tabIndex = 0;
    root.setAttribute('role', 'application');

    for (const name of LAYER_ORDER) {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      canvas.setAttribute('aria-hidden', 'true');
      const ctx = canvas.getContext('2d', { alpha: name === 'overlay' }) as PaintContext | null;
      if (!ctx) throw new Error(`canvas 2d context unavailable for layer ${name}`);
      root.appendChild(canvas);
      this.layers.set(name, { name, canvas, ctx });
    }

    host.appendChild(root);
    this.root = root;
  }

  layer(name: LayerName): Layer {
    const layer = this.layers.get(name);
    if (!layer) throw new Error(`unknown layer ${name}`);
    return layer;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  get viewportWidth(): number {
    return this.width;
  }

  get viewportHeight(): number {
    return this.height;
  }

  region(name: LayerName): Region {
    return this.regions.get(name) ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  /**
   * Re-lays out every layer for a new viewport size, header geometry, or DPR.
   * Assigning `canvas.width` resets the context transform, so the DPR scale is
   * re-applied here on every call — forgetting that is the usual cause of a
   * blurry canvas after a monitor switch.
   */
  resize(width: number, height: number, originX: number, originY: number, dpr: number): void {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.originX = Math.max(0, originX);
    this.originY = Math.max(0, originY);
    this.dpr = dpr > 0 ? dpr : 1;

    const bodyW = Math.max(0, this.width - this.originX);
    const bodyH = Math.max(0, this.height - this.originY);

    const next: Record<LayerName, Region> = {
      corner: { x: 0, y: 0, width: this.originX, height: this.originY },
      colHeader: { x: this.originX, y: 0, width: bodyW, height: this.originY },
      rowHeader: { x: 0, y: this.originY, width: this.originX, height: bodyH },
      body: { x: this.originX, y: this.originY, width: bodyW, height: bodyH },
      // Full-bleed so a column resize guide can span the header and the body.
      overlay: { x: 0, y: 0, width: this.width, height: this.height },
    };

    for (const name of LAYER_ORDER) {
      const layer = this.layers.get(name);
      const region = next[name];
      if (!layer || !region) continue;
      this.regions.set(name, region);

      const { canvas, ctx } = layer;
      canvas.style.left = `${region.x}px`;
      canvas.style.top = `${region.y}px`;
      canvas.style.width = `${region.width}px`;
      canvas.style.height = `${region.height}px`;
      canvas.width = Math.max(1, Math.round(region.width * this.dpr));
      canvas.height = Math.max(1, Math.round(region.height * this.dpr));
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
  }

  /**
   * Watches for devicePixelRatio changes — dragging the window to a different
   * monitor, or zooming, changes it without any resize event on some platforms.
   * Re-armed on every change because a MediaQueryList is bound to one value.
   */
  watchDpr(onChange: (dpr: number) => void): () => void {
    let query: MediaQueryList | null = null;
    let handler: (() => void) | null = null;

    const arm = (): void => {
      if (handler && query) query.removeEventListener('change', handler);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      handler = () => {
        onChange(window.devicePixelRatio);
        arm();
      };
      query.addEventListener('change', handler);
    };

    arm();
    this.disposeDprWatch = () => {
      if (handler && query) query.removeEventListener('change', handler);
      query = null;
      handler = null;
    };
    return this.disposeDprWatch;
  }

  destroy(): void {
    this.disposeDprWatch?.();
    this.disposeDprWatch = null;
    this.root.remove();
    this.layers.clear();
    this.regions.clear();
  }
}
