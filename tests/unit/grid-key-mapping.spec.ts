/**
 * Keyboard → SelectionEvent mapping (GRID-SPEC §7).
 *
 * Pure, so the whole modifier/platform matrix is testable without a DOM. This
 * is where "Cmd+Down works on my Mac but Ctrl+Down does nothing on Windows"
 * bugs live, and where a browser shortcut gets silently hijacked.
 */
import { describe, expect, it } from 'vitest';
import { selectionActionFromKey, type KeyEventLike } from '@/grid/keyboard';

function key(partial: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    key: partial.key,
    shiftKey: partial.shiftKey ?? false,
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
  };
}

const mac = 'mac' as const;
const other = 'other' as const;

describe('arrow keys', () => {
  it.each([
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
  ] as const)('%s maps to a %s move', (input, direction) => {
    expect(selectionActionFromKey(key({ key: input }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'move', direction, shift: false, meta: false },
    });
  });

  it('carries shift so the selection extends', () => {
    expect(selectionActionFromKey(key({ key: 'ArrowDown', shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'move', direction: 'down', shift: true, meta: false },
    });
  });

  it('treats cmd as the data-edge modifier on mac', () => {
    expect(selectionActionFromKey(key({ key: 'ArrowDown', metaKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'move', direction: 'down', shift: false, meta: true },
    });
  });

  it('does not treat ctrl as the data-edge modifier on mac', () => {
    // Ctrl+Arrow is a Mission Control shortcut on macOS; claiming it breaks the OS.
    expect(selectionActionFromKey(key({ key: 'ArrowDown', ctrlKey: true }), mac)).toBeNull();
  });

  it('treats ctrl as the data-edge modifier off mac', () => {
    expect(selectionActionFromKey(key({ key: 'ArrowDown', ctrlKey: true }), other)).toEqual({
      kind: 'selection',
      event: { type: 'move', direction: 'down', shift: false, meta: true },
    });
  });

  it('does not treat cmd as the data-edge modifier off mac', () => {
    expect(selectionActionFromKey(key({ key: 'ArrowLeft', metaKey: true }), other)).toBeNull();
  });

  it('combines the primary modifier with shift', () => {
    expect(
      selectionActionFromKey(key({ key: 'ArrowRight', metaKey: true, shiftKey: true }), mac),
    ).toEqual({
      kind: 'selection',
      event: { type: 'move', direction: 'right', shift: true, meta: true },
    });
  });

  it('leaves alt+arrow alone', () => {
    expect(selectionActionFromKey(key({ key: 'ArrowLeft', altKey: true }), mac)).toBeNull();
    expect(
      selectionActionFromKey(key({ key: 'ArrowLeft', altKey: true, metaKey: true }), mac),
    ).toBeNull();
  });
});

describe('paging', () => {
  it.each([
    ['PageUp', 'up'],
    ['PageDown', 'down'],
  ] as const)('%s pages %s', (input, direction) => {
    expect(selectionActionFromKey(key({ key: input }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'movePage', direction, shift: false },
    });
  });

  it('shift+PageDown extends by a page', () => {
    expect(selectionActionFromKey(key({ key: 'PageDown', shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'movePage', direction: 'down', shift: true },
    });
  });

  it('ignores paging with a primary modifier, which belongs to the browser', () => {
    expect(selectionActionFromKey(key({ key: 'PageDown', metaKey: true }), mac)).toBeNull();
  });
});

describe('Home / End', () => {
  it('Home goes to the first column of the row', () => {
    expect(selectionActionFromKey(key({ key: 'Home' }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'firstCol', shift: false },
    });
  });

  it('End goes to the last column of the row', () => {
    expect(selectionActionFromKey(key({ key: 'End' }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'lastCol', shift: false },
    });
  });

  it('cmd+Home goes to the very first cell', () => {
    expect(selectionActionFromKey(key({ key: 'Home', metaKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'start', shift: false },
    });
  });

  it('cmd+End goes to the very last cell', () => {
    expect(selectionActionFromKey(key({ key: 'End', metaKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'end', shift: false },
    });
  });

  it('ctrl+Home/End do the same off mac', () => {
    expect(selectionActionFromKey(key({ key: 'Home', ctrlKey: true }), other)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'start', shift: false },
    });
    expect(selectionActionFromKey(key({ key: 'End', ctrlKey: true }), other)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'end', shift: false },
    });
  });

  it('shift+Home selects to the first column', () => {
    expect(selectionActionFromKey(key({ key: 'Home', shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveToEdge', edge: 'firstCol', shift: true },
    });
  });

  it('cmd+shift+End selects through to the last cell', () => {
    expect(selectionActionFromKey(key({ key: 'End', metaKey: true, shiftKey: true }), mac)).toEqual(
      {
        kind: 'selection',
        event: { type: 'moveToEdge', edge: 'end', shift: true },
      },
    );
  });
});

describe('Tab and Enter', () => {
  it('Tab moves forward', () => {
    expect(selectionActionFromKey(key({ key: 'Tab' }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveTab', reverse: false },
    });
  });

  it('Shift+Tab moves backward', () => {
    expect(selectionActionFromKey(key({ key: 'Tab', shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveTab', reverse: true },
    });
  });

  it('Enter moves down', () => {
    expect(selectionActionFromKey(key({ key: 'Enter' }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveEnter', reverse: false },
    });
  });

  it('Shift+Enter moves up', () => {
    expect(selectionActionFromKey(key({ key: 'Enter', shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'moveEnter', reverse: true },
    });
  });
});

describe('Escape and select-all', () => {
  it('Escape clears to a single cell', () => {
    expect(selectionActionFromKey(key({ key: 'Escape' }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'clear' },
    });
  });

  it('cmd+A selects everything on mac', () => {
    expect(selectionActionFromKey(key({ key: 'a', metaKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'clickCorner' },
    });
  });

  it('ctrl+A selects everything off mac', () => {
    expect(selectionActionFromKey(key({ key: 'a', ctrlKey: true }), other)).toEqual({
      kind: 'selection',
      event: { type: 'clickCorner' },
    });
  });

  it('accepts an uppercase A, since shift is implied by the modifier', () => {
    expect(selectionActionFromKey(key({ key: 'A', metaKey: true, shiftKey: true }), mac)).toEqual({
      kind: 'selection',
      event: { type: 'clickCorner' },
    });
  });
});

describe('copy', () => {
  it('cmd+C reports a copy action rather than a selection change', () => {
    expect(selectionActionFromKey(key({ key: 'c', metaKey: true }), mac)).toEqual({ kind: 'copy' });
  });

  it('ctrl+C reports a copy action off mac', () => {
    expect(selectionActionFromKey(key({ key: 'c', ctrlKey: true }), other)).toEqual({
      kind: 'copy',
    });
  });

  it('does not treat cmd+C as copy off mac', () => {
    expect(selectionActionFromKey(key({ key: 'c', metaKey: true }), other)).toBeNull();
  });
});

describe('keys that must pass through untouched', () => {
  it.each([
    ['a', 'plain letter'],
    ['c', 'plain letter that is not a copy'],
    ['1', 'digit'],
    ['F5', 'function key'],
    ['Backspace', 'editing key'],
    ['Delete', 'editing key'],
    [' ', 'space'],
    ['UnknownKey', 'unmapped key'],
  ])('ignores %s (%s)', (input) => {
    expect(selectionActionFromKey(key({ key: input }), mac)).toBeNull();
  });

  it('ignores alt combos entirely', () => {
    expect(selectionActionFromKey(key({ key: 'a', altKey: true, metaKey: true }), mac)).toBeNull();
    expect(selectionActionFromKey(key({ key: 'Tab', altKey: true }), mac)).toBeNull();
  });

  it('ignores cmd+Tab, which is the macOS app switcher', () => {
    expect(selectionActionFromKey(key({ key: 'Tab', metaKey: true }), mac)).toBeNull();
  });

  it('ignores shift+Escape rather than inventing a meaning', () => {
    expect(selectionActionFromKey(key({ key: 'Escape', shiftKey: true }), mac)).toBeNull();
  });
});
