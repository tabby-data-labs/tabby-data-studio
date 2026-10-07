/**
 * The exports store (PLAN Phase 8).
 *
 * Tier 2 — an adapter over the IPC bridge — so written after the implementation.
 * The serialisation is Tier 1 in `export-serialise.spec.ts` and the streaming
 * lifecycle is in `export-service.spec.ts`; what belongs here is the bridge
 * boundary, and one case in particular:
 *
 * **The payload must be a plain object.** The dialog keeps its options in a `ref`,
 * so what it hands this store is a reactive Proxy, and Electron's structured clone
 * cannot serialise a Proxy. The failure mode is nasty: `invoke` rejects with "An
 * object could not be cloned", which the bridge helper turns into a bare
 * `NOT_CONNECTED`, which reads as "main has no handler for this channel" — a
 * completely different bug from the real one. A stubbed bridge accepts anything, so
 * only an explicit `isReactive` assertion catches it here; the smoke harness is what
 * actually found it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { isReactive, reactive } from 'vue';
import { defaultExportOptions, type ExportOptions } from '@shared/export';
import type { ExportProgressEvent, ExportStartResponse } from '@shared/ipc-contract';
import type { Result, TabbyErrorCode } from '@shared/errors';
import { useExportsStore } from '@/stores/exports';

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(code: TabbyErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function startResponse(overrides: Partial<ExportStartResponse> = {}): ExportStartResponse {
  return {
    exportId: 'x1',
    path: '/tmp/out.csv',
    fileName: 'out.csv',
    format: 'csv',
    insertTarget: null,
    ...overrides,
  };
}

function progress(overrides: Partial<ExportProgressEvent> = {}): ExportProgressEvent {
  return {
    exportId: 'x1',
    path: '/tmp/out.csv',
    phase: 'streaming',
    rowsWritten: 0,
    bytesWritten: 0,
    elapsedMs: 0,
    message: null,
    ...overrides,
  };
}

interface Stub {
  readonly startCalls: { resultId: string; options: ExportOptions }[];
  readonly cancelCalls: string[];
  readonly listeners: ((event: ExportProgressEvent) => void)[];
  startResult: Result<ExportStartResponse | null>;
  cancelResult: Result<void>;
  unsubscribes: number;
}

function stubApi(): Stub {
  const stub: Stub = {
    startCalls: [],
    cancelCalls: [],
    listeners: [],
    startResult: ok(startResponse()),
    cancelResult: ok(undefined),
    unsubscribes: 0,
  };

  // This spec runs in the node environment, so `window` has to be provided as well
  // as `tabby`: the store reads `window.tabby`, exactly as the renderer does. (The
  // component specs do the opposite — they stub `tabby` alone, because replacing
  // `window` in a DOM environment takes `Event` and `document` with it.)
  vi.stubGlobal('window', {
    tabby: {
      versions: { electron: '0', chrome: '0', node: '0' },
      db: {
        exportStart: (request: { resultId: string; options: ExportOptions }) => {
          stub.startCalls.push(request);
          return Promise.resolve(stub.startResult);
        },
        exportCancel: (exportId: string) => {
          stub.cancelCalls.push(exportId);
          return Promise.resolve(stub.cancelResult);
        },
      },
      events: {
        onExportProgress: (listener: (event: ExportProgressEvent) => void) => {
          stub.listeners.push(listener);
          return () => {
            stub.unsubscribes += 1;
          };
        },
      },
    },
  });

  return stub;
}

let stub: Stub;

function emit(event: ExportProgressEvent): void {
  for (const listener of stub.listeners) listener(event);
}

beforeEach(() => {
  setActivePinia(createPinia());
  stub = stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('start', () => {
  it('sends a plain object across the bridge, never a reactive proxy', async () => {
    const store = useExportsStore();
    // Exactly what the dialog holds: a ref-wrapped, therefore proxied, options
    // object. This is the regression test for "An object could not be cloned".
    const options = reactive(defaultExportOptions('csv'));
    expect(isReactive(options)).toBe(true);

    await store.start('r1', options);

    expect(stub.startCalls).toHaveLength(1);
    const sent = stub.startCalls[0]!;
    expect(sent.resultId).toBe('r1');
    expect(isReactive(sent.options)).toBe(false);
    expect(isReactive(sent)).toBe(false);
    expect(sent.options).toEqual(defaultExportOptions('csv'));
  });

  it('sends every option field, and no others', async () => {
    const store = useExportsStore();
    await store.start('r1', {
      ...defaultExportOptions('sql'),
      rowsPerInsert: 7,
      nullText: '<NULL>',
    });
    const sent = stub.startCalls[0]!;
    expect(Object.keys(sent.options).sort()).toEqual([
      'delimiter',
      'encoding',
      'format',
      'includeHeader',
      'lineEnding',
      'nullText',
      'rowsPerInsert',
      'writeBom',
    ]);
    expect(sent.options.rowsPerInsert).toBe(7);
    expect(sent.options.nullText).toBe('<NULL>');
  });

  it('registers a streaming entry when main accepts the export', async () => {
    const store = useExportsStore();
    const result = await store.start('r1', defaultExportOptions('csv'));

    expect(result.ok).toBe(true);
    expect(store.all).toHaveLength(1);
    expect(store.all[0]).toMatchObject({
      exportId: 'x1',
      fileName: 'out.csv',
      phase: 'streaming',
      rowsWritten: 0,
    });
    expect(store.busy).toBe(true);
    expect(store.running).toHaveLength(1);
  });

  it('treats a dismissed save dialog as neither an export nor an error', async () => {
    stub.startResult = ok(null);
    const store = useExportsStore();
    const result = await store.start('r1', defaultExportOptions('csv'));

    expect(result).toEqual({ ok: true, value: null });
    expect(store.all).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.busy).toBe(false);
  });

  it('records a refusal and adds nothing to the tray', async () => {
    stub.startResult = failure('EXPORT_BUSY', '2 exports are already running');
    const store = useExportsStore();
    const result = await store.start('r1', defaultExportOptions('csv'));

    expect(result.ok).toBe(false);
    expect(store.error?.code).toBe('EXPORT_BUSY');
    expect(store.all).toEqual([]);
  });

  it('turns a rejected bridge call into a tagged error rather than a throw', async () => {
    // `invoke` is what makes "no handler registered" indistinguishable from "the
    // server said no"; an uncaught rejection here would be invisible to the user
    // and fatal to both Electron harnesses.
    vi.stubGlobal('window', {
      tabby: {
        versions: { electron: '0', chrome: '0', node: '0' },
        db: {
          exportStart: () => Promise.reject(new Error('No handler registered for export:start')),
        },
        events: { onExportProgress: () => () => undefined },
      },
    });

    const store = useExportsStore();
    const result = await store.start('r1', defaultExportOptions('csv'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_CONNECTED');
    expect(store.error?.code).toBe('NOT_CONNECTED');
  });
});

describe('progress events', () => {
  it('updates the entry in place as rows are written', async () => {
    const store = useExportsStore();
    store.subscribe();
    await store.start('r1', defaultExportOptions('csv'));

    emit(progress({ rowsWritten: 5_000, bytesWritten: 80_000, elapsedMs: 120 }));
    expect(store.all[0]).toMatchObject({ phase: 'streaming', rowsWritten: 5_000 });
    expect(store.busy).toBe(true);

    emit(
      progress({
        phase: 'done',
        rowsWritten: 200_000,
        bytesWritten: 3_200_000,
        elapsedMs: 2_400,
      }),
    );
    expect(store.all[0]).toMatchObject({ phase: 'done', rowsWritten: 200_000 });
    expect(store.busy).toBe(false);
    expect(store.running).toEqual([]);
    // A finished export stays visible until dismissed.
    expect(store.finished).toHaveLength(1);
  });

  it('carries a failure message and clears busy', async () => {
    const store = useExportsStore();
    store.subscribe();
    await store.start('r1', defaultExportOptions('csv'));

    emit(
      progress({ phase: 'failed', rowsWritten: 5_000, message: 'server closed the connection' }),
    );
    expect(store.all[0]?.phase).toBe('failed');
    expect(store.all[0]?.message).toBe('server closed the connection');
    expect(store.busy).toBe(false);
  });

  it('ignores an event for an export it never started', async () => {
    const store = useExportsStore();
    store.subscribe();
    await store.start('r1', defaultExportOptions('csv'));

    emit(progress({ exportId: 'someone-else', phase: 'done', rowsWritten: 99 }));
    expect(store.all).toHaveLength(1);
    expect(store.all[0]?.exportId).toBe('x1');
  });

  it('ignores an event for an export the user already dismissed', async () => {
    const store = useExportsStore();
    store.subscribe();
    await store.start('r1', defaultExportOptions('csv'));

    store.dismiss('x1');
    expect(store.all).toEqual([]);
    emit(progress({ phase: 'done', rowsWritten: 10 }));
    // Resurrecting a row the user closed would be worse than dropping a number.
    expect(store.all).toEqual([]);
  });

  it('subscribes once and detaches cleanly', async () => {
    const store = useExportsStore();
    store.subscribe();
    store.subscribe();
    expect(stub.listeners).toHaveLength(1);

    store.unsubscribe();
    expect(stub.unsubscribes).toBe(1);
    store.unsubscribe();
    expect(stub.unsubscribes).toBe(1);
  });
});

describe('cancel and dismiss', () => {
  it('forwards a cancel to main', async () => {
    const store = useExportsStore();
    await store.start('r1', defaultExportOptions('csv'));

    expect((await store.cancel('x1')).ok).toBe(true);
    expect(stub.cancelCalls).toEqual(['x1']);
    // Cancelling does not remove the row: the terminal event does the reporting.
    expect(store.all).toHaveLength(1);
  });

  it('records a failed cancel', async () => {
    stub.cancelResult = failure('NOT_FOUND', 'no export with id x1');
    const store = useExportsStore();
    const result = await store.cancel('x1');
    expect(result.ok).toBe(false);
    expect(store.error?.code).toBe('NOT_FOUND');
  });

  it('dismisses one entry and clears only the finished ones', async () => {
    const store = useExportsStore();
    store.subscribe();

    stub.startResult = ok(startResponse({ exportId: 'a' }));
    await store.start('r1', defaultExportOptions('csv'));
    stub.startResult = ok(startResponse({ exportId: 'b', fileName: 'b.csv' }));
    await store.start('r2', defaultExportOptions('csv'));

    emit(progress({ exportId: 'a', phase: 'done', rowsWritten: 10 }));
    expect(store.running.map((item) => item.exportId)).toEqual(['b']);

    store.clearFinished();
    expect(store.all.map((item) => item.exportId)).toEqual(['b']);

    store.dismiss('b');
    expect(store.all).toEqual([]);
  });
});
