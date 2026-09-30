import { cellText } from './cell-format';
import type { CellValue, ColumnMeta } from './types';

export interface InspectTarget {
  readonly row: number;
  readonly column: ColumnMeta;
  readonly cell: CellValue | undefined;
}

const LABEL_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#8ba0bb',
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const VALUE_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#e6edf7',
  fontSize: '12px',
  // The grid is user-select:none; the inspector is the one place a value must
  // be copyable by hand.
  userSelect: 'text',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
};

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Pretty-prints JSON when the preview is complete enough to parse. */
function prettyJson(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2);
  } catch {
    // A truncated or non-JSON payload is shown as-is; guessing would be worse.
    return preview;
  }
}

/**
 * The full, untruncated value of one cell (GRID-SPEC §7).
 *
 * The canvas necessarily truncates to the column width, so this panel is the
 * only way to read a long text, a whole JSON document, or a bytea payload. It
 * also shows a timestamp in both UTC and local time, because a database viewer
 * that hides the offset invites timezone bugs.
 */
export class CellInspector {
  readonly element: HTMLDivElement;

  private readonly body: HTMLDivElement;
  private target: InspectTarget | null = null;

  constructor(host: HTMLElement) {
    const element = document.createElement('div');
    element.setAttribute('role', 'complementary');
    element.setAttribute('aria-label', 'Cell inspector');
    // A slide-over inside the grid root rather than a sibling panel: it needs no
    // layout coordination with the app shell, and it cannot be orphaned by a
    // host element that mounts after the grid does.
    Object.assign(element.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      width: '380px',
      maxWidth: '60%',
      zIndex: '10',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '12px',
      borderLeft: '1px solid #1c3a5e',
      background: '#0a1626',
      boxShadow: '-8px 0 24px rgba(0,0,0,0.45)',
      overflow: 'auto',
      font: '12px "JetBrains Mono", ui-monospace, monospace',
    } as Partial<CSSStyleDeclaration>);
    element.hidden = true;

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
    } as Partial<CSSStyleDeclaration>);

    const title = document.createElement('span');
    Object.assign(title.style, LABEL_STYLE);
    title.textContent = 'Cell inspector';
    header.appendChild(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close inspector');
    Object.assign(close.style, {
      background: 'transparent',
      border: '1px solid #1c3a5e',
      borderRadius: '4px',
      color: '#8ba0bb',
      cursor: 'pointer',
      font: 'inherit',
      lineHeight: '1',
      padding: '2px 6px',
    } as Partial<CSSStyleDeclaration>);
    close.addEventListener('click', () => this.hide());
    header.appendChild(close);

    const body = document.createElement('div');
    Object.assign(body.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    } as Partial<CSSStyleDeclaration>);

    element.append(header, body);
    host.appendChild(element);

    this.element = element;
    this.body = body;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get current(): InspectTarget | null {
    return this.target;
  }

  show(target: InspectTarget): void {
    this.target = target;
    this.body.replaceChildren();
    this.addRow('Row', String(target.row + 1));
    this.addRow('Column', target.column.name);
    this.addRow('Type', `${target.column.typeName}${target.column.nullable ? ' (nullable)' : ''}`);

    const cell = target.cell;
    if (cell === undefined) {
      this.addValue('not loaded');
    } else {
      this.renderValue(cell);
    }

    this.element.hidden = false;
  }

  private renderValue(cell: CellValue): void {
    switch (cell.kind) {
      case 'null':
        this.addValue('NULL', true);
        return;
      case 'time': {
        const date = new Date(cell.epochMs);
        this.addValue(date.toISOString());
        this.addRow('Local', date.toString());
        this.addRow('Epoch (ms)', String(cell.epochMs));
        this.addRow('Source zone', cell.tz);
        return;
      }
      case 'binary': {
        this.addRow('Size', `${cell.byteLength} bytes`);
        this.addValue(toHex(cell.preview), false, `first ${cell.preview.byteLength} bytes as hex`);
        return;
      }
      case 'json': {
        this.addRow('Size', `${cell.byteLength} bytes`);
        this.addValue(prettyJson(cell.preview));
        return;
      }
      case 'number':
        this.addValue(cell.raw !== '' ? cell.raw : String(cell.value));
        // Surfacing the divergence is the point: a double cannot hold every
        // int8 or numeric, and the user should be able to see when that bites.
        if (cell.raw !== '' && cell.raw !== String(cell.value)) {
          this.addRow('As JS number', `${cell.value} (lossy — the text above is exact)`);
        }
        return;
      case 'error':
        this.addValue(cell.message, true);
        return;
      default:
        this.addValue(cellText(cell).text);
        return;
    }
  }

  private addRow(label: string, value: string): void {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'baseline';

    const key = document.createElement('span');
    Object.assign(key.style, LABEL_STYLE);
    key.textContent = label;

    const val = document.createElement('span');
    Object.assign(val.style, VALUE_STYLE);
    val.textContent = value;

    row.append(key, val);
    this.body.appendChild(row);
  }

  private addValue(text: string, muted = false, caption?: string): void {
    const block = document.createElement('div');
    block.style.display = 'flex';
    block.style.flexDirection = 'column';
    block.style.gap = '4px';

    const label = document.createElement('span');
    Object.assign(label.style, LABEL_STYLE);
    label.textContent = 'Value';
    block.appendChild(label);

    const pre = document.createElement('pre');
    Object.assign(pre.style, {
      ...VALUE_STYLE,
      margin: '0',
      padding: '8px',
      borderRadius: '4px',
      border: '1px solid #1c3a5e',
      background: '#030b16',
      maxHeight: '40vh',
      overflow: 'auto',
      fontFamily: 'inherit',
      fontStyle: muted ? 'italic' : 'normal',
      color: muted ? '#8ba0bb' : '#e6edf7',
    } as Partial<CSSStyleDeclaration>);
    pre.setAttribute('data-inspector-value', '');
    pre.textContent = text;
    block.appendChild(pre);

    if (caption) {
      const note = document.createElement('span');
      Object.assign(note.style, LABEL_STYLE);
      note.textContent = caption;
      block.appendChild(note);
    }

    this.body.appendChild(block);
  }

  hide(): void {
    this.target = null;
    this.body.replaceChildren();
    this.element.hidden = true;
  }

  destroy(): void {
    this.hide();
    this.element.remove();
  }
}
