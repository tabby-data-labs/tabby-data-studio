import { scrub } from '../shared/errors';

/**
 * Main-process logging.
 *
 * Every message passes through `scrub()` before it is written. That is not
 * paranoia: connection strings, `pg` errors and DSNs routinely embed
 * `password=…`, and a log line is exactly where such a secret ends up persisted
 * long after the session. Centralising it here means no call site can forget.
 */
function write(level: string, scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${scope}: ${scrub(message)}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
}

export function logInfo(scope: string, message: string): void {
  write('INFO', scope, message);
}

export function logWarn(scope: string, message: string): void {
  write('WARN', scope, message);
}

export function logError(scope: string, error: unknown): void {
  const message = error instanceof Error ? `${error.message}` : String(error);
  write('ERROR', scope, message);
}

/** Records a rejected IPC payload without echoing the payload itself. */
export function logRejectedPayload(
  scope: string,
  channel: string,
  field: string,
  reason: string,
): void {
  write('WARN', scope, `rejected ${channel} — ${field}: ${reason}`);
}
