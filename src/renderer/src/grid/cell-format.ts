import type { CellValue } from './types';

export type CellAlign = 'left' | 'right' | 'center';
export type CellStyle = 'normal' | 'muted' | 'null' | 'error';

export interface CellText {
  readonly text: string;
  readonly align: CellAlign;
  readonly style: CellStyle;
}

export function isNullCell(cell: CellValue): boolean {
  return cell.kind === 'null';
}

/**
 * Pure cell → display-string mapping (GRID-SPEC §9).
 *
 * `number` renders from `raw`, never from `value`: Postgres int8 and numeric
 * routinely exceed 2^53, and a double silently rounds them. Rendering 12.50 as
 * "12.5" would also be a lie about what the server sent.
 *
 * `time` renders as UTC ISO-8601 so output is identical on every machine; the
 * Cell Inspector shows the original offset.
 */
export function cellText(cell: CellValue): CellText {
  switch (cell.kind) {
    case 'null':
      return { text: 'NULL', align: 'left', style: 'null' };
    case 'bool':
      return { text: cell.value ? 'true' : 'false', align: 'center', style: 'normal' };
    case 'number':
      return {
        text: cell.raw !== '' ? cell.raw : String(cell.value),
        align: 'right',
        style: 'normal',
      };
    case 'text':
      return { text: cell.value, align: 'left', style: 'normal' };
    case 'time':
      return { text: new Date(cell.epochMs).toISOString(), align: 'left', style: 'normal' };
    case 'binary':
      return { text: `<${cell.byteLength} bytes>`, align: 'left', style: 'muted' };
    case 'json':
      return { text: cell.preview, align: 'left', style: 'normal' };
    case 'error':
      return { text: cell.message, align: 'left', style: 'error' };
  }
}
