import type { PaintContext } from '@/grid/paint';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface RecordingCtx {
  readonly ctx: PaintContext;
  readonly calls: RecordedCall[];
}

const METHODS = [
  'clearRect',
  'fillRect',
  'strokeRect',
  'fillText',
  'save',
  'restore',
  'beginPath',
  'moveTo',
  'lineTo',
  'stroke',
  'rect',
  'clip',
  'setTransform',
] as const;

/**
 * A canvas 2D context that records instead of drawing.
 *
 * Property assignments are recorded as `set:<name>` calls so draw-order
 * assertions can see *which* colour a shape was painted with, not just that a
 * shape was painted. This is what lets the paint pass be unit-tested with no
 * native canvas package — a deliberate dependency-budget decision.
 */
export function createRecordingCtx(charWidth = 6): RecordingCtx {
  const calls: RecordedCall[] = [];

  const target: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '12px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineWidth: 1,
  };

  for (const method of METHODS) {
    target[method] = (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  }
  target['measureText'] = (text: string): { width: number } => ({ width: text.length * charWidth });

  const ctx = new Proxy(target, {
    set(store, property, value) {
      store[property as string] = value;
      calls.push({ method: `set:${String(property)}`, args: [value] });
      return true;
    },
  }) as unknown as PaintContext;

  return { ctx, calls };
}

/** Method names only, in call order, excluding property assignments. */
export function methodOrder(calls: readonly RecordedCall[]): string[] {
  return calls.filter((call) => !call.method.startsWith('set:')).map((call) => call.method);
}

export function firstIndex(calls: readonly RecordedCall[], method: string): number {
  return calls.findIndex((call) => call.method === method);
}

export function countCalls(calls: readonly RecordedCall[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

/** All fillText payloads, in draw order. */
export function drawnText(calls: readonly RecordedCall[]): string[] {
  return calls.filter((call) => call.method === 'fillText').map((call) => String(call.args[0]));
}

/**
 * Depth of save/restore nesting after the full call list. Zero means balanced;
 * a leak here corrupts every subsequent frame because clip regions accumulate.
 */
export function saveRestoreBalance(calls: readonly RecordedCall[]): number {
  let depth = 0;
  for (const call of calls) {
    if (call.method === 'save') depth += 1;
    else if (call.method === 'restore') depth -= 1;
    if (depth < 0) return depth;
  }
  return depth;
}
