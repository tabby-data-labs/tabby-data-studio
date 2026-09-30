/**
 * Hover tooltip (GRID-SPEC §7).
 *
 * Shows the untruncated cell text without the user having to open the
 * inspector. A DOM element rather than canvas paint, so it can overflow the
 * grid bounds and be read by assistive tech.
 */
export class Tooltip {
  readonly element: HTMLDivElement;

  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private current = '';

  /** Delay before appearing, so a sweep across the grid does not strobe. */
  private readonly delayMs: number;

  constructor(container: HTMLElement, delayMs = 450) {
    this.delayMs = Math.max(0, delayMs);

    const element = document.createElement('div');
    element.setAttribute('role', 'tooltip');
    element.hidden = true;
    Object.assign(element.style, {
      position: 'absolute',
      zIndex: '15',
      maxWidth: '480px',
      padding: '5px 8px',
      borderRadius: '5px',
      border: '1px solid #1c3a5e',
      background: '#0a1626',
      color: '#e6edf7',
      font: '11px "JetBrains Mono", ui-monospace, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      pointerEvents: 'none',
      boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    } as Partial<CSSStyleDeclaration>);

    container.appendChild(element);
    this.element = element;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** Schedules a tooltip for (x, y). Calling again before it fires replaces it. */
  schedule(x: number, y: number, text: string): void {
    this.cancel();
    if (text === '') return;

    // Re-showing the same text (a jittering pointer within one cell) is instant.
    if (text === this.current && this.visible) {
      this.position(x, y);
      return;
    }

    this.current = text;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.element.textContent = text;
      this.element.hidden = false;
      this.position(x, y);
    }, this.delayMs);
  }

  private position(x: number, y: number): void {
    const rect = this.element.getBoundingClientRect();
    const flipX = x + rect.width + 16 > window.innerWidth;
    const flipY = y + rect.height + 24 > window.innerHeight;
    this.element.style.left = `${Math.max(4, flipX ? x - rect.width - 10 : x + 14)}px`;
    this.element.style.top = `${Math.max(4, flipY ? y - rect.height - 10 : y + 18)}px`;
  }

  cancel(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  hide(): void {
    this.cancel();
    this.current = '';
    this.element.hidden = true;
  }

  destroy(): void {
    this.hide();
    this.element.remove();
  }
}
