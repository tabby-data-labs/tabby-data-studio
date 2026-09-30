export interface MenuItem {
  readonly label: string;
  readonly action: () => void;
  readonly disabled?: boolean;
  /** Draws a rule after this entry. */
  readonly separatorAfter?: boolean;
}

/**
 * DOM overlay context menu (GRID-SPEC §2, §7).
 *
 * Lives in the DOM rather than on a canvas because it must be keyboard
 * navigable and readable by assistive tech — a painted menu is neither.
 */
export class ContextMenu {
  readonly element: HTMLDivElement;

  private items: readonly MenuItem[] = [];
  private focusIndex = -1;
  private attached = false;
  private readonly onDocPointerDown = (event: PointerEvent): void => {
    if (!this.element.contains(event.target as Node)) this.hide();
  };
  private readonly onDocKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.hide();
    }
  };
  private readonly onScroll = (): void => this.hide();

  constructor(container: HTMLElement) {
    const element = document.createElement('div');
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-orientation', 'vertical');
    element.hidden = true;
    Object.assign(element.style, {
      position: 'absolute',
      zIndex: '20',
      minWidth: '180px',
      padding: '4px',
      borderRadius: '6px',
      border: '1px solid #1c3a5e',
      background: '#0a1626',
      boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
      font: '12px "JetBrains Mono", ui-monospace, monospace',
      color: '#e6edf7',
    } as Partial<CSSStyleDeclaration>);

    container.appendChild(element);
    this.element = element;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  show(x: number, y: number, items: readonly MenuItem[]): void {
    this.hide();
    if (items.length === 0) return;

    this.items = items;
    this.element.replaceChildren();

    items.forEach((item, index) => {
      const entry = document.createElement('div');
      entry.setAttribute('role', 'menuitem');
      entry.tabIndex = -1;
      entry.textContent = item.label;
      Object.assign(entry.style, {
        padding: '5px 10px',
        borderRadius: '4px',
        cursor: item.disabled ? 'default' : 'pointer',
        opacity: item.disabled ? '0.45' : '1',
        whiteSpace: 'nowrap',
      } as Partial<CSSStyleDeclaration>);
      if (item.disabled) entry.setAttribute('aria-disabled', 'true');

      entry.addEventListener('pointerenter', () => this.setFocus(index));
      entry.addEventListener('click', (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        this.hide();
        item.action();
      });

      this.element.appendChild(entry);

      if (item.separatorAfter && index < items.length - 1) {
        const rule = document.createElement('div');
        rule.setAttribute('role', 'separator');
        Object.assign(rule.style, {
          height: '1px',
          margin: '4px 2px',
          background: '#1c3a5e',
        } as Partial<CSSStyleDeclaration>);
        this.element.appendChild(rule);
      }
    });

    this.element.hidden = false;
    this.position(x, y);

    if (!this.attached) {
      this.attached = true;
      document.addEventListener('pointerdown', this.onDocPointerDown, true);
      document.addEventListener('keydown', this.onDocKeydown, true);
      window.addEventListener('blur', this.onScroll);
      window.addEventListener('resize', this.onScroll);
    }

    this.setFocus(this.firstEnabledIndex());
  }

  /** Keeps the menu inside the viewport instead of clipping off an edge. */
  private position(x: number, y: number): void {
    const rect = this.element.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width - 4);
    const maxY = Math.max(0, window.innerHeight - rect.height - 4);
    this.element.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    this.element.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
  }

  private firstEnabledIndex(): number {
    const index = this.items.findIndex((item) => !item.disabled);
    return index < 0 ? -1 : index;
  }

  private entries(): HTMLElement[] {
    return Array.from(this.element.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  private setFocus(index: number): void {
    const entries = this.entries();
    if (this.focusIndex >= 0) {
      const previous = entries[this.focusIndex];
      if (previous) previous.style.background = '';
    }
    this.focusIndex = index;
    const next = entries[index];
    if (next) {
      next.style.background = 'rgba(59,118,240,0.28)';
      next.focus();
    }
  }

  /** Arrow-key navigation, so the menu is usable without a pointer. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible) return false;
    const enabled = this.items
      .map((item, index) => ({ item, index }))
      .filter((entry) => !entry.item.disabled)
      .map((entry) => entry.index);
    if (enabled.length === 0) return true;

    switch (event.key) {
      case 'ArrowDown': {
        const at = enabled.indexOf(this.focusIndex);
        this.setFocus(enabled[(at + 1) % enabled.length] ?? enabled[0]!);
        return true;
      }
      case 'ArrowUp': {
        const at = enabled.indexOf(this.focusIndex);
        const previous = at <= 0 ? enabled.length - 1 : at - 1;
        this.setFocus(enabled[previous] ?? enabled[0]!);
        return true;
      }
      case 'Enter':
      case ' ': {
        const item = this.items[this.focusIndex];
        this.hide();
        if (item && !item.disabled) item.action();
        return true;
      }
      case 'Home':
        this.setFocus(enabled[0]!);
        return true;
      case 'End':
        this.setFocus(enabled[enabled.length - 1]!);
        return true;
      default:
        return false;
    }
  }

  hide(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.focusIndex = -1;
    if (this.attached) {
      this.attached = false;
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener('keydown', this.onDocKeydown, true);
      window.removeEventListener('blur', this.onScroll);
      window.removeEventListener('resize', this.onScroll);
    }
  }

  destroy(): void {
    this.hide();
    this.element.remove();
  }
}
