import type { GridTheme } from './types';

/** Matches the Tailwind @theme tokens in styles/main.css. */
export const DARK_THEME: GridTheme = {
  background: '#030b16',
  stripe: '#08111f',
  gridline: '#152a45',
  text: '#e6edf7',
  muted: '#8ba0bb',
  headerBackground: '#0a1626',
  headerText: '#e6edf7',
  headerBorder: '#1c3a5e',
  selectionFill: 'rgba(59, 118, 240, 0.22)',
  selectionStroke: '#3b76f0',
  activeHandle: '#3b76f0',
  frozenShadow: '#000000',
  placeholder: '#1c3a5e',
  cellFont: '12px "JetBrains Mono", ui-monospace, monospace',
  headerFont: 'bold 12px "JetBrains Mono", ui-monospace, monospace',
  headerSubFont: '10px "JetBrains Mono", ui-monospace, monospace',
  cellPaddingX: 8,
  rowHeight: 22,
  headerHeight: 34,
  rowHeaderWidth: 56,
};

export const LIGHT_THEME: GridTheme = {
  ...DARK_THEME,
  background: '#ffffff',
  stripe: '#f6f8fb',
  gridline: '#dde4ee',
  text: '#14202e',
  muted: '#64748b',
  headerBackground: '#f1f5f9',
  headerText: '#14202e',
  headerBorder: '#cbd5e1',
  selectionFill: 'rgba(59, 118, 240, 0.16)',
  placeholder: '#cbd5e1',
};
