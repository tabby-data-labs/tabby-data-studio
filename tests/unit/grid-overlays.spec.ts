// @vitest-environment happy-dom
/**
 * Tier 2 (AGENTS.md): the DOM overlay widgets. Written after the implementation,
 * but required before the phase can be called done.
 *
 * These three are the parts of the grid a canvas cannot provide: a menu that is
 * keyboard navigable, a tooltip that does not steal clicks, and an inspector
 * whose value must be selectable so it can be copied by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CellInspector } from '@/grid/inspector';
import { ContextMenu, type MenuItem } from '@/grid/context-menu';
import { Tooltip } from '@/grid/tooltip';
import type { ColumnMeta } from '@/grid/types';

const COLUMN: ColumnMeta = {
  name: 'created_at',
  typeName: 'timestamptz',
  typeOid: 1184,
  nullable: true,
  widthHint: 180,
};

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

// ── CellInspector ────────────────────────────────────────────────────────────

describe('CellInspector', () => {
  it('starts hidden', () => {
    const inspector = new CellInspector(host);
    expect(inspector.visible).toBe(false);
    inspector.destroy();
  });

  it('reports row, column, type and nullability', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 41, column: COLUMN, cell: { kind: 'null' } });
    expect(inspector.visible).toBe(true);
    const text = inspector.element.textContent ?? '';
    expect(text).toContain('42'); // 1-based for the user
    expect(text).toContain('created_at');
    expect(text).toContain('timestamptz');
    expect(text).toContain('nullable');
    inspector.destroy();
  });

  it('renders NULL explicitly rather than as a blank', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 0, column: COLUMN, cell: { kind: 'null' } });
    expect(inspector.element.querySelector('[data-inspector-value]')?.textContent).toBe('NULL');
    inspector.destroy();
  });

  it('says when a cell has not loaded yet', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 0, column: COLUMN, cell: undefined });
    expect(inspector.element.textContent).toContain('not loaded');
    inspector.destroy();
  });

  it('shows a timestamp in UTC, local and epoch form', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: COLUMN,
      cell: { kind: 'time', epochMs: 1_790_000_000_000, tz: 'UTC' },
    });
    const text = inspector.element.textContent ?? '';
    expect(text).toContain(new Date(1_790_000_000_000).toISOString());
    expect(text).toContain('1790000000000');
    expect(text).toContain('Local');
    inspector.destroy();
  });

  it('shows bytea size and a hex preview', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: COLUMN,
      cell: { kind: 'binary', byteLength: 4096, preview: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
    });
    const text = inspector.element.textContent ?? '';
    expect(text).toContain('4096 bytes');
    expect(text).toContain('deadbeef');
    inspector.destroy();
  });

  it('pretty-prints parseable JSON', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: COLUMN,
      cell: { kind: 'json', preview: '{"a":1,"b":[2,3]}', byteLength: 13 },
    });
    const value = inspector.element.querySelector('[data-inspector-value]')?.textContent ?? '';
    expect(value).toContain('\n');
    expect(JSON.parse(value)).toEqual({ a: 1, b: [2, 3] });
    inspector.destroy();
  });

  it('falls back to the raw preview when JSON is truncated', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: COLUMN,
      cell: { kind: 'json', preview: '{"a":1,"b":', byteLength: 999 },
    });
    expect(inspector.element.querySelector('[data-inspector-value]')?.textContent).toBe(
      '{"a":1,"b":',
    );
    inspector.destroy();
  });

  it('flags an int8 that a JS double cannot hold exactly', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: { ...COLUMN, name: 'id', typeName: 'int8' },
      cell: { kind: 'number', value: 9_007_199_254_740_992, raw: '9007199254740993' },
    });
    const text = inspector.element.textContent ?? '';
    expect(inspector.element.querySelector('[data-inspector-value]')?.textContent).toBe(
      '9007199254740993',
    );
    expect(text).toContain('lossy');
    inspector.destroy();
  });

  it('does not warn when the number round-trips exactly', () => {
    const inspector = new CellInspector(host);
    inspector.show({
      row: 0,
      column: COLUMN,
      cell: { kind: 'number', value: 42, raw: '42' },
    });
    expect(inspector.element.textContent).not.toContain('lossy');
    inspector.destroy();
  });

  it('makes the value selectable, unlike the grid itself', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 0, column: COLUMN, cell: { kind: 'text', value: 'copy me' } });
    const value = inspector.element.querySelector<HTMLElement>('[data-inspector-value]');
    expect(value?.style.userSelect).toBe('text');
    inspector.destroy();
  });

  it('clears its content on hide and can be reopened', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 0, column: COLUMN, cell: { kind: 'text', value: 'first' } });
    inspector.hide();
    expect(inspector.visible).toBe(false);
    expect(inspector.current).toBeNull();

    inspector.show({ row: 1, column: COLUMN, cell: { kind: 'text', value: 'second' } });
    expect(inspector.element.textContent).toContain('second');
    expect(inspector.element.textContent).not.toContain('first');
    inspector.destroy();
  });

  it('closes from its own button', () => {
    const inspector = new CellInspector(host);
    inspector.show({ row: 0, column: COLUMN, cell: { kind: 'text', value: 'x' } });
    const close = inspector.element.querySelector<HTMLButtonElement>('button[aria-label]');
    close?.click();
    expect(inspector.visible).toBe(false);
    inspector.destroy();
  });

  it('removes itself from the DOM on destroy', () => {
    const inspector = new CellInspector(host);
    inspector.destroy();
    expect(host.querySelector('[role="complementary"]')).toBeNull();
  });
});

// ── ContextMenu ──────────────────────────────────────────────────────────────

function items(overrides: Partial<MenuItem>[] = []): MenuItem[] {
  return overrides.map((override, index) => ({
    label: override.label ?? `item ${index}`,
    action: override.action ?? (() => {}),
    ...override,
  }));
}

describe('ContextMenu', () => {
  it('starts hidden and shows on demand with a menu role', () => {
    const menu = new ContextMenu(host);
    expect(menu.visible).toBe(false);
    menu.show(10, 10, items([{ label: 'Copy' }]));
    expect(menu.visible).toBe(true);
    expect(menu.element.getAttribute('role')).toBe('menu');
    menu.destroy();
  });

  it('renders one menuitem per entry', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'Copy' }, { label: 'Paste' }]));
    const rendered = menu.element.querySelectorAll('[role="menuitem"]');
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.textContent).toBe('Copy');
    menu.destroy();
  });

  it('does not open for an empty item list', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, []);
    expect(menu.visible).toBe(false);
    menu.destroy();
  });

  it('marks disabled entries and refuses to run them', () => {
    const action = vi.fn();
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'Nope', disabled: true, action }]));
    const entry = menu.element.querySelector<HTMLElement>('[role="menuitem"]');
    expect(entry?.getAttribute('aria-disabled')).toBe('true');
    entry?.click();
    expect(action).not.toHaveBeenCalled();
    menu.destroy();
  });

  it('runs the action and closes when an entry is clicked', () => {
    const action = vi.fn();
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'Copy', action }]));
    menu.element.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(menu.visible).toBe(false);
    menu.destroy();
  });

  it('replaces a previous menu rather than stacking entries', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'first' }]));
    menu.show(0, 0, items([{ label: 'a' }, { label: 'b' }, { label: 'c' }]));
    expect(menu.element.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    expect(menu.element.textContent).not.toContain('first');
    menu.destroy();
  });

  it('draws a separator only where asked, and not after the last item', () => {
    const menu = new ContextMenu(host);
    menu.show(
      0,
      0,
      items([
        { label: 'a', separatorAfter: true },
        { label: 'b', separatorAfter: true },
      ]),
    );
    expect(menu.element.querySelectorAll('[role="separator"]')).toHaveLength(1);
    menu.destroy();
  });

  it('navigates with arrow keys and activates with Enter', () => {
    const first = vi.fn();
    const second = vi.fn();
    const menu = new ContextMenu(host);
    menu.show(
      0,
      0,
      items([
        { label: 'a', action: first },
        { label: 'b', action: second },
      ]),
    );

    const press = (key: string): boolean => menu.handleKey(new KeyboardEvent('keydown', { key }));

    expect(press('ArrowDown')).toBe(true);
    expect(press('Enter')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(menu.visible).toBe(false);
    menu.destroy();
  });

  it('wraps around in both directions', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'a' }, { label: 'b' }, { label: 'c' }]));
    const press = (key: string): void => {
      menu.handleKey(new KeyboardEvent('keydown', { key }));
    };

    press('ArrowUp'); // from the first item, wraps to the last
    const rendered = () => menu.element.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(rendered()[2]?.style.background).not.toBe('');

    press('ArrowDown'); // wraps back to the first
    expect(rendered()[0]?.style.background).not.toBe('');
    menu.destroy();
  });

  it('skips disabled entries while navigating', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'a' }, { label: 'b', disabled: true }, { label: 'c' }]));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const rendered = menu.element.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(rendered[2]?.style.background).not.toBe('');
    expect(rendered[1]?.style.background).toBe('');
    menu.destroy();
  });

  it('ignores keys while closed', () => {
    const menu = new ContextMenu(host);
    expect(menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false);
    menu.destroy();
  });

  it('clamps into the viewport instead of hanging off an edge', () => {
    const menu = new ContextMenu(host);
    menu.show(99_999, 99_999, items([{ label: 'a' }]));
    const left = Number.parseFloat(menu.element.style.left);
    const top = Number.parseFloat(menu.element.style.top);
    expect(left).toBeLessThanOrEqual(Math.max(0, window.innerWidth));
    expect(top).toBeLessThanOrEqual(Math.max(0, window.innerHeight));
    expect(left).toBeGreaterThanOrEqual(0);
    menu.destroy();
  });

  it('removes itself on destroy', () => {
    const menu = new ContextMenu(host);
    menu.show(0, 0, items([{ label: 'a' }]));
    menu.destroy();
    expect(menu.visible).toBe(false);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});

// ── Tooltip ──────────────────────────────────────────────────────────────────

describe('Tooltip', () => {
  it('starts hidden and is click-through', () => {
    const tip = new Tooltip(host);
    expect(tip.visible).toBe(false);
    expect(tip.element.getAttribute('role')).toBe('tooltip');
    expect(tip.element.style.pointerEvents).toBe('none');
    tip.destroy();
  });

  it('appears only after the delay, so a sweep does not strobe', () => {
    vi.useFakeTimers();
    const tip = new Tooltip(host, 450);
    tip.schedule(10, 10, 'value');
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(449);
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(2);
    expect(tip.visible).toBe(true);
    expect(tip.element.textContent).toBe('value');
    tip.destroy();
  });

  it('does not schedule anything for empty text', () => {
    vi.useFakeTimers();
    const tip = new Tooltip(host, 100);
    tip.schedule(10, 10, '');
    vi.advanceTimersByTime(500);
    expect(tip.visible).toBe(false);
    tip.destroy();
  });

  it('replaces a pending tooltip when the pointer moves on', () => {
    vi.useFakeTimers();
    const tip = new Tooltip(host, 100);
    tip.schedule(10, 10, 'first');
    vi.advanceTimersByTime(50);
    tip.schedule(20, 20, 'second');
    vi.advanceTimersByTime(200);
    expect(tip.element.textContent).toBe('second');
    tip.destroy();
  });

  it('cancel() stops a scheduled tooltip from appearing', () => {
    vi.useFakeTimers();
    const tip = new Tooltip(host, 100);
    tip.schedule(10, 10, 'value');
    tip.cancel();
    vi.advanceTimersByTime(500);
    expect(tip.visible).toBe(false);
    tip.destroy();
  });

  it('hide() clears the current value so a re-show is not instant', () => {
    vi.useFakeTimers();
    const tip = new Tooltip(host, 100);
    tip.schedule(10, 10, 'value');
    vi.advanceTimersByTime(200);
    expect(tip.visible).toBe(true);
    tip.hide();
    expect(tip.visible).toBe(false);

    tip.schedule(10, 10, 'value');
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(200);
    expect(tip.visible).toBe(true);
    tip.destroy();
  });

  it('removes itself on destroy', () => {
    const tip = new Tooltip(host);
    tip.destroy();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });
});
