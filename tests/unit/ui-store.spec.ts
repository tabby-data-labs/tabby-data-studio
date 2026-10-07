// @vitest-environment happy-dom
/**
 * The UI store: theme and overlay state (PLAN Phase 8).
 *
 * Tier 2 — it touches `document` and the bridge. The theme is the part worth
 * testing, because it has two representations that can disagree: the store's value
 * and `<html data-theme>`, which is what the CSS in `styles/main.css` selects on.
 * A store that updates one and not the other produces a UI that says "light" while
 * every surface stays dark.
 *
 * Also here: the optimistic-apply decision. A failed persist must not revert the
 * theme behind the user's back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Result, TabbyErrorCode } from '@shared/errors';
import { DARK_THEME, LIGHT_THEME } from '@/grid/theme';
import { useUiStore } from '@/stores/ui';

let patchCalls: { theme?: string }[];
let patchResult: Result<unknown>;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(code: TabbyErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function stubApi(): void {
  patchCalls = [];
  patchResult = ok({ connections: [], window: {}, theme: 'dark', loadWarning: null });
  vi.stubGlobal('window', {
    tabby: {
      versions: { electron: '0', chrome: '0', node: '0' },
      db: {
        patchSettings: (patch: { theme?: string }) => {
          patchCalls.push(patch);
          return Promise.resolve(patchResult);
        },
      },
      events: {},
    },
  });
}

/** What `main.ts` does before mounting, so the store can adopt it. */
function appliedTheme(): string | undefined {
  return document.documentElement.dataset['theme'];
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  stubApi();
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset['theme'];
});

describe('initial theme', () => {
  it('adopts whatever main.ts already put on the document', () => {
    document.documentElement.dataset['theme'] = 'light';
    expect(useUiStore().theme).toBe('light');
  });

  it('defaults to dark when the document says nothing', () => {
    expect(useUiStore().theme).toBe('dark');
  });

  it('treats an unrecognised value as dark rather than as a third theme', () => {
    document.documentElement.dataset['theme'] = 'solarised';
    expect(useUiStore().theme).toBe('dark');
  });
});

describe('applying the theme', () => {
  it('writes the document attribute, which is what the CSS selects on', () => {
    const ui = useUiStore();
    ui.apply();
    expect(appliedTheme()).toBe('dark');

    ui.setTheme('light');
    expect(appliedTheme()).toBe('light');
    expect(ui.theme).toBe('light');
  });

  it('hands the grid the matching canvas palette', () => {
    const ui = useUiStore();
    expect(ui.gridTheme).toBe(DARK_THEME);
    ui.setTheme('light');
    // The grid cannot read CSS variables — it paints to a canvas — so the two
    // palettes have to be kept in step by hand, and this is the link.
    expect(ui.gridTheme).toBe(LIGHT_THEME);
  });

  it('load() sets both at once', () => {
    const ui = useUiStore();
    ui.load('light');
    expect(ui.theme).toBe('light');
    expect(appliedTheme()).toBe('light');
  });
});

describe('toggling', () => {
  it('flips, applies immediately, and persists', async () => {
    const ui = useUiStore();
    const pending = ui.toggleTheme();
    // Applied before the write resolves: awaiting a JSON write to change a colour
    // would make the toggle feel broken.
    expect(ui.theme).toBe('light');
    expect(appliedTheme()).toBe('light');

    await pending;
    expect(patchCalls).toEqual([{ theme: 'light' }]);
    expect(ui.error).toBeNull();
  });

  it('flips back', async () => {
    const ui = useUiStore();
    await ui.toggleTheme();
    await ui.toggleTheme();
    expect(ui.theme).toBe('dark');
    expect(appliedTheme()).toBe('dark');
    expect(patchCalls).toEqual([{ theme: 'light' }, { theme: 'dark' }]);
  });

  it('keeps the chosen theme when the write fails, and says why', async () => {
    patchResult = failure('INTERNAL', 'settings file is read-only');
    const ui = useUiStore();
    await ui.toggleTheme();
    await flush();

    // Reverting behind the user's back because a background write failed is a
    // worse surprise than launching next time in the old theme.
    expect(ui.theme).toBe('light');
    expect(appliedTheme()).toBe('light');
    expect(ui.error?.message).toBe('settings file is read-only');
  });

  it('clears a previous failure once a toggle succeeds', async () => {
    patchResult = failure('INTERNAL', 'nope');
    const ui = useUiStore();
    await ui.toggleTheme();
    expect(ui.error).not.toBeNull();

    patchResult = ok({});
    await ui.toggleTheme();
    expect(ui.error).toBeNull();
  });

  it('turns a rejected bridge call into an error rather than a throw', async () => {
    vi.stubGlobal('window', {
      tabby: {
        versions: { electron: '0', chrome: '0', node: '0' },
        db: { patchSettings: () => Promise.reject(new Error('No handler registered')) },
        events: {},
      },
    });
    const ui = useUiStore();
    await ui.toggleTheme();
    await flush();

    expect(ui.theme).toBe('light');
    expect(ui.error?.code).toBe('INTERNAL');
  });
});

describe('overlays', () => {
  it('opens and closes the palette and the export dialog independently', () => {
    const ui = useUiStore();
    expect(ui.paletteOpen).toBe(false);
    expect(ui.exportOpen).toBe(false);

    ui.openPalette();
    expect(ui.paletteOpen).toBe(true);
    ui.openExport();
    expect(ui.exportOpen).toBe(true);

    ui.closePalette();
    expect(ui.paletteOpen).toBe(false);
    expect(ui.exportOpen).toBe(true);
    ui.closeExport();
    expect(ui.exportOpen).toBe(false);
  });

  it('toggles the palette', () => {
    const ui = useUiStore();
    ui.togglePalette();
    expect(ui.paletteOpen).toBe(true);
    ui.togglePalette();
    expect(ui.paletteOpen).toBe(false);
  });

  it('closes the palette before the export dialog', () => {
    // Escape on a stack of overlays must peel one layer, not all of them: closing
    // the palette should not also throw away an export dialog half filled in.
    const ui = useUiStore();
    ui.openExport();
    ui.openPalette();

    expect(ui.closeTopOverlay()).toBe(true);
    expect(ui.paletteOpen).toBe(false);
    expect(ui.exportOpen).toBe(true);

    expect(ui.closeTopOverlay()).toBe(true);
    expect(ui.exportOpen).toBe(false);

    expect(ui.closeTopOverlay()).toBe(false);
  });
});
