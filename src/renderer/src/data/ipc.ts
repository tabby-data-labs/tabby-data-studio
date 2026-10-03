import type { Result, TabbyError, TabbyErrorCode } from '@shared/errors';

/**
 * Every renderer → main call goes through this.
 *
 * The IPC contract promises `Result<T>` and never a throw, but that promise only
 * covers a channel that has a handler. `ipcRenderer.invoke` **rejects** when there
 * is none — "No handler registered for 'settings:get'" — which is exactly what
 * happens on a version skew, or in a harness that boots the renderer without the
 * router. An uncaught rejection in the renderer surfaces as a console error the
 * user cannot see and cannot act on, and it takes the smoke and bench harnesses
 * down with it, because both treat console errors as failures.
 *
 * Turning it into a tagged `Result` means the same error-handling path covers
 * "the server said no" and "there was nobody to ask".
 */
export async function invoke<T>(
  call: () => Promise<Result<T>>,
  code: TabbyErrorCode,
): Promise<Result<T>> {
  try {
    return await call();
  } catch (error) {
    return { ok: false, error: toError(error, code) };
  }
}

/**
 * For calls whose result is discarded (`resultDispose` on a closing tab). A
 * rejected promise nobody awaits is an unhandled rejection, which is fatal to a
 * harness and invisible to a user; the console is the only channel left.
 *
 * Called synchronously — wrapping in `Promise.resolve().then(…)` would defer it a
 * microtask and quietly reorder side effects the caller can observe.
 */
export function invokeDetached(call: () => Promise<unknown>, context: string): void {
  const report = (error: unknown): void => {
    console.warn(
      `tabby: ${context} failed`,
      error instanceof Error ? error.message : String(error),
    );
  };
  try {
    void Promise.resolve(call()).catch(report);
  } catch (error) {
    // `call()` itself threw — `window.tabby` missing, for instance.
    report(error);
  }
}

function toError(error: unknown, code: TabbyErrorCode): TabbyError {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as TabbyError).code === 'string' &&
    typeof (error as TabbyError).message === 'string'
  ) {
    return error as TabbyError;
  }
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}
