import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ThemeName } from '@shared/domain';
import type { TabbyError } from '@shared/errors';
import { invoke } from '@/data/ipc';
import { DARK_THEME, LIGHT_THEME } from '@/grid/theme';
import type { GridTheme } from '@/grid/types';

/** Whatever `main.ts` put on `<html>`, defaulting to dark. */
function appliedTheme(): ThemeName {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';
}

/**
 * Window-level UI state (PLAN Phase 8): the theme and which overlay is open.
 *
 * These live in a store rather than in `App.vue` because two of them have to
 * outlive a component: the theme is applied to `<html>` and must survive every
 * remount, and the overlays are opened by the command palette — a sibling of the
 * thing it opens, with no prop path between them.
 *
 * The theme is applied **optimistically**. `patchSettings` is a synchronous JSON
 * write in main, but awaiting it before repainting would make the toggle feel
 * broken, and a failed persist is a much smaller problem than a laggy one: the UI
 * keeps the theme the user asked for and reports the write failure beside it.
 */
export const useUiStore = defineStore('ui', () => {
  // Adopted from `<html data-theme>`, which `main.ts` sets before mounting so the
  // first paint is already in the persisted theme. Reading it back rather than
  // defaulting to dark is what keeps this store and the document from disagreeing.
  const theme = ref<ThemeName>(appliedTheme());
  const paletteOpen = ref(false);
  const exportOpen = ref(false);
  const error = ref<TabbyError | null>(null);

  /** The canvas palette that matches the CSS one, so the grid follows the theme. */
  const gridTheme = computed<GridTheme>(() => (theme.value === 'light' ? LIGHT_THEME : DARK_THEME));

  /**
   * Writes the theme onto `<html>`, which is what the light-theme variable block in
   * `styles/main.css` selects on. Setting a dataset entry rather than a class keeps
   * it out of the way of Tailwind's own class names.
   */
  function apply(): void {
    document.documentElement.dataset['theme'] = theme.value;
  }

  function setTheme(next: ThemeName): void {
    theme.value = next;
    apply();
  }

  /** Adopts the persisted theme at startup, before the first paint if possible. */
  function load(persisted: ThemeName): void {
    setTheme(persisted);
  }

  async function toggleTheme(): Promise<void> {
    const next: ThemeName = theme.value === 'dark' ? 'light' : 'dark';
    setTheme(next);
    error.value = null;

    const result = await invoke(() => window.tabby.db.patchSettings({ theme: next }), 'INTERNAL');
    if (result.ok) return;
    // Reported, not rolled back: reverting a theme the user just chose, because a
    // background write failed, is a worse surprise than launching in the old one.
    error.value = result.error;
  }

  function openPalette(): void {
    paletteOpen.value = true;
  }

  function closePalette(): void {
    paletteOpen.value = false;
  }

  function togglePalette(): void {
    paletteOpen.value = !paletteOpen.value;
  }

  function openExport(): void {
    exportOpen.value = true;
  }

  function closeExport(): void {
    exportOpen.value = false;
  }

  /** Closes whichever overlay is open. Returns true if it closed something. */
  function closeTopOverlay(): boolean {
    if (paletteOpen.value) {
      paletteOpen.value = false;
      return true;
    }
    if (exportOpen.value) {
      exportOpen.value = false;
      return true;
    }
    return false;
  }

  return {
    theme,
    gridTheme,
    paletteOpen,
    exportOpen,
    error,
    apply,
    setTheme,
    load,
    toggleTheme,
    openPalette,
    closePalette,
    togglePalette,
    openExport,
    closeExport,
    closeTopOverlay,
  };
});
