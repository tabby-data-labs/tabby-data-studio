import { computed, ref, shallowReactive } from 'vue';
import { defineStore } from 'pinia';
import type { ExportProgressEvent, ExportStartResponse } from '@shared/ipc-contract';
import type { ExportOptions } from '@shared/export';
import type { Result, TabbyError } from '@shared/errors';
import type { Unsubscribe } from '@shared/renderer-api';
import { invoke } from '@/data/ipc';

export type ExportPhase = ExportProgressEvent['phase'];

export interface ExportState {
  readonly exportId: string;
  readonly path: string;
  readonly fileName: string;
  readonly format: ExportOptions['format'];
  readonly phase: ExportPhase;
  readonly rowsWritten: number;
  readonly bytesWritten: number;
  readonly elapsedMs: number;
  readonly message: string | null;
}

/**
 * Copies the options into a plain object, field by field.
 *
 * Not a formality. The dialog holds its options in a `ref`, so `options.value` is a
 * **reactive Proxy**, and Electron's structured clone cannot serialise a Proxy —
 * the call rejects with "An object could not be cloned", which reaches the caller
 * as a bare `NOT_CONNECTED` and looks like a missing handler rather than like what
 * it is. Spreading would work today but would silently forward a nested proxy if a
 * future option gained one; naming the fields cannot.
 *
 * Found by the smoke harness driving the real dialog. No unit test caught it,
 * because a stubbed bridge accepts anything.
 */
function plainOptions(options: ExportOptions): ExportOptions {
  return {
    format: options.format,
    delimiter: options.delimiter,
    includeHeader: options.includeHeader,
    nullText: options.nullText,
    encoding: options.encoding,
    lineEnding: options.lineEnding,
    writeBom: options.writeBom,
    rowsPerInsert: options.rowsPerInsert,
  };
}

/**
 * Exports in flight and just finished (PLAN Phase 8).
 *
 * This store holds **no row data**, which is the point of the design: main streams
 * the result straight to disk and the renderer's only view of it is a counter. A
 * million-row export therefore costs this process a few numbers per export, and the
 * phase's ~150MB renderer-memory criterion is met structurally rather than by
 * tuning anything.
 *
 * Terminal states stay in the list until dismissed. An export that finishes while
 * the user is looking at something else has to be discoverable afterwards, and
 * "it vanished" is indistinguishable from "it never ran".
 */
export const useExportsStore = defineStore('exports', () => {
  const exports = shallowReactive(new Map<string, ExportState>());
  const error = ref<TabbyError | null>(null);

  let detached: Unsubscribe[] = [];

  const all = computed<readonly ExportState[]>(() => [...exports.values()]);
  const running = computed(() => all.value.filter((item) => item.phase === 'streaming'));
  const finished = computed(() => all.value.filter((item) => item.phase !== 'streaming'));
  const busy = computed(() => running.value.length > 0);

  function stateOf(exportId: string): ExportState | null {
    return exports.get(exportId) ?? null;
  }

  /**
   * Opens the save dialog in main and, if the user picks a destination, starts the
   * stream.
   *
   * `ok(null)` means the dialog was dismissed. That is a decision, not a failure,
   * and callers must not report it as one.
   */
  async function start(
    resultId: string,
    options: ExportOptions,
  ): Promise<Result<ExportStartResponse | null>> {
    error.value = null;
    const result = await invoke(
      () => window.tabby.db.exportStart({ resultId, options: plainOptions(options) }),
      'NOT_CONNECTED',
    );
    if (!result.ok) {
      error.value = result.error;
      return result;
    }
    const started = result.value;
    if (started === null) return result;

    exports.set(started.exportId, {
      exportId: started.exportId,
      path: started.path,
      fileName: started.fileName,
      format: started.format,
      phase: 'streaming',
      rowsWritten: 0,
      bytesWritten: 0,
      elapsedMs: 0,
      message: null,
    });
    return result;
  }

  async function cancel(exportId: string): Promise<Result<void>> {
    const result = await invoke(() => window.tabby.db.exportCancel(exportId), 'NOT_CONNECTED');
    if (!result.ok) error.value = result.error;
    return result;
  }

  function dismiss(exportId: string): void {
    exports.delete(exportId);
  }

  function clearFinished(): void {
    for (const item of exports.values()) {
      if (item.phase !== 'streaming') exports.delete(item.exportId);
    }
  }

  function subscribe(): void {
    if (detached.length > 0) return;
    detached.push(
      window.tabby.events.onExportProgress((event) => {
        const previous = exports.get(event.exportId);
        // An event for an export this window never started — a dismissed dialog
        // that raced, or a state that was already dismissed. Dropping it is right:
        // resurrecting a row the user closed would be worse than losing a number.
        if (!previous) return;
        exports.set(event.exportId, {
          ...previous,
          phase: event.phase,
          rowsWritten: event.rowsWritten,
          bytesWritten: event.bytesWritten,
          elapsedMs: event.elapsedMs,
          message: event.message,
        });
      }),
    );
  }

  function unsubscribe(): void {
    for (const detach of detached) detach();
    detached = [];
  }

  return {
    exports,
    all,
    running,
    finished,
    busy,
    error,
    stateOf,
    start,
    cancel,
    dismiss,
    clearFinished,
    subscribe,
    unsubscribe,
  };
});
