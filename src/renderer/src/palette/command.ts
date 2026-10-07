/**
 * One thing the command palette can do (PLAN Phase 8).
 *
 * Kept in its own module so the app can build a command list without importing the
 * component, and so the palette can be tested against plain objects.
 */
export interface PaletteCommand {
  /** Stable within a session; used as the list key. */
  readonly id: string;
  /** What the user types against, and what the row shows. */
  readonly title: string;
  /** Second line: a keyboard shortcut or a one-line explanation. */
  readonly hint?: string;
  /** Section label, shown above a run of rows that share it. */
  readonly group?: string;
  readonly run: () => void;
}
