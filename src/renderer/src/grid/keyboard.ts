import type { MoveDirection, SelectionEvent } from './types';

export type Platform = 'mac' | 'other';

/** The subset of KeyboardEvent this module reads, so it can be tested without a DOM. */
export interface KeyEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

export type SelectionAction =
  { readonly kind: 'selection'; readonly event: SelectionEvent } | { readonly kind: 'copy' };

const ARROWS: Readonly<Record<string, MoveDirection>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  return /Mac|iPod|iPhone|iPad/.test(navigator.userAgent ?? '') ? 'mac' : 'other';
}

/**
 * Translate a key press into a selection action, or null when the grid should
 * leave the key alone.
 *
 * Returning null is as important as returning an action: the caller only calls
 * `preventDefault()` for a non-null result, so anything unclaimed still reaches
 * the browser and the OS. That is why alt-combos, the non-primary modifier, and
 * cmd+Enter all return null — cmd+Tab is the macOS app switcher, and cmd+Enter
 * belongs to the query console, not the grid.
 */
export function selectionActionFromKey(
  event: KeyEventLike,
  platform: Platform,
): SelectionAction | null {
  // Alt is reserved for the OS and for browser menus everywhere.
  if (event.altKey) return null;

  const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const secondary = platform === 'mac' ? event.ctrlKey : event.metaKey;
  // Claiming ctrl on macOS (Mission Control) or cmd on Windows would fight the OS.
  if (secondary) return null;

  const shift = event.shiftKey;
  const select = (selectionEvent: SelectionEvent): SelectionAction => ({
    kind: 'selection',
    event: selectionEvent,
  });

  const direction = ARROWS[event.key];
  if (direction) {
    return select({ type: 'move', direction, shift, meta: primary });
  }

  switch (event.key) {
    case 'PageUp':
    case 'PageDown':
      // cmd/ctrl+PageUp is tab switching in most shells; leave it alone.
      if (primary) return null;
      return select({
        type: 'movePage',
        direction: event.key === 'PageUp' ? 'up' : 'down',
        shift,
      });

    case 'Home':
      return select({ type: 'moveToEdge', edge: primary ? 'start' : 'firstCol', shift });

    case 'End':
      return select({ type: 'moveToEdge', edge: primary ? 'end' : 'lastCol', shift });

    case 'Tab':
      // cmd+Tab is the macOS app switcher and ctrl+Tab switches browser tabs.
      if (primary) return null;
      return select({ type: 'moveTab', reverse: shift });

    case 'Enter':
      // Reserved for "run query" in the console.
      if (primary) return null;
      return select({ type: 'moveEnter', reverse: shift });

    case 'Escape':
      // Only a bare Escape; shift+Escape has no meaning worth inventing.
      return shift ? null : select({ type: 'clear' });

    default:
      break;
  }

  const letter = event.key.length === 1 ? event.key.toLowerCase() : '';
  if (letter === 'a' && primary) return select({ type: 'clickCorner' });
  if (letter === 'c' && primary) return { kind: 'copy' };

  return null;
}
