export interface ThumbGeometry {
  readonly offset: number;
  readonly size: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Thumb size and position for a custom scrollbar.
 *
 * Returns null when no scrolling is possible — the caller should hide the
 * scrollbar entirely rather than draw a full-length thumb. The thumb is clamped
 * to `minThumb` so it stays grabbable at a 10M-row extent, and never exceeds
 * the track.
 */
export function thumbGeometry(
  content: number,
  viewport: number,
  offset: number,
  track: number,
  minThumb = 24,
): ThumbGeometry | null {
  if (!(content > 0) || !(viewport > 0) || !(track > 0)) return null;
  if (!(content > viewport)) return null;

  const maxOffset = content - viewport;
  const cap = Math.min(minThumb, track);
  const size = Math.min(track, Math.max(cap, (viewport / content) * track));
  const free = track - size;
  const safeOffset = Number.isFinite(offset) ? offset : 0;
  const t = clamp(safeOffset / maxOffset, 0, 1);

  return { offset: t * free, size };
}

/** Exact inverse of {@link thumbGeometry}, used while dragging the thumb. */
export function scrollOffsetFromThumb(
  thumbOffset: number,
  thumbSize: number,
  track: number,
  content: number,
  viewport: number,
): number {
  const free = track - thumbSize;
  if (!(free > 0)) return 0;
  const maxOffset = Math.max(0, content - viewport);
  const t = clamp((Number.isFinite(thumbOffset) ? thumbOffset : 0) / free, 0, 1);
  return t * maxOffset;
}

export type ScrollAlign = 'top' | 'center' | 'bottom' | 'nearest';

export interface ScrollControllerOptions {
  readonly target: HTMLElement;
  /** Read live: the row height can change with the theme. */
  readonly rowHeight: () => number;
  readonly viewportHeight: () => number;
  readonly onScroll: () => void;
}

/**
 * Wheel, trackpad and programmatic scrolling.
 *
 * `deltaMode` must be honoured: Firefox reports lines, some platforms report
 * pages, and macOS trackpads report pixels with their own momentum. Adding our
 * own inertia on top of a trackpad's doubles it, so none is added here.
 */
export class ScrollController {
  scrollTop = 0;
  scrollLeft = 0;
  maxScrollTop = 0;
  maxScrollLeft = 0;

  private readonly options: ScrollControllerOptions;
  private attached = false;

  constructor(options: ScrollControllerOptions) {
    this.options = options;
  }

  setExtents(maxScrollTop: number, maxScrollLeft: number): void {
    this.maxScrollTop = Math.max(0, maxScrollTop);
    this.maxScrollLeft = Math.max(0, maxScrollLeft);
    const nextTop = clamp(this.scrollTop, 0, this.maxScrollTop);
    const nextLeft = clamp(this.scrollLeft, 0, this.maxScrollLeft);
    if (nextTop !== this.scrollTop || nextLeft !== this.scrollLeft) {
      this.scrollTop = nextTop;
      this.scrollLeft = nextLeft;
      this.options.onScroll();
    }
  }

  set(scrollTop: number, scrollLeft: number): void {
    this.scrollTop = clamp(scrollTop, 0, this.maxScrollTop);
    this.scrollLeft = clamp(scrollLeft, 0, this.maxScrollLeft);
    this.options.onScroll();
  }

  scrollBy(dx: number, dy: number): void {
    this.set(this.scrollTop + dy, this.scrollLeft + dx);
  }

  scrollToRow(row: number, align: ScrollAlign = 'top'): void {
    const rowHeight = this.options.rowHeight();
    const viewportHeight = this.options.viewportHeight();
    const top = row * rowHeight;

    let target: number;
    switch (align) {
      case 'center':
        target = top - (viewportHeight - rowHeight) / 2;
        break;
      case 'bottom':
        target = top - (viewportHeight - rowHeight);
        break;
      case 'nearest': {
        if (top < this.scrollTop) target = top;
        else if (top + rowHeight > this.scrollTop + viewportHeight) {
          target = top + rowHeight - viewportHeight;
        } else return;
        break;
      }
      case 'top':
      default:
        target = top;
        break;
    }
    this.set(target, this.scrollLeft);
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rowHeight = this.options.rowHeight();
    const unit =
      event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? this.options.viewportHeight() : 1;

    let dx = event.deltaX * unit;
    let dy = event.deltaY * unit;
    // Shift+wheel scrolls horizontally, matching Excel and every browser.
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.scrollBy(dx, dy);
  };

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    // passive:false is required or preventDefault is ignored and the page scrolls.
    this.options.target.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  destroy(): void {
    if (!this.attached) return;
    this.attached = false;
    this.options.target.removeEventListener('wheel', this.handleWheel);
  }
}
