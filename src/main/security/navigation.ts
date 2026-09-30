import { app, session, shell } from 'electron';
import { DEV_CSP, PROD_CSP } from './csp';

export type CspProfile = 'prod' | 'dev';

/**
 * The only permissions Tabby's renderer may hold.
 *
 * `clipboard-sanitized-write` is what makes Cmd+C work: Chromium asks for it via
 * the permission *check* handler (synchronous), not the request handler, so
 * setting only the request handler leaves copy silently broken. Sanitized write
 * is the narrow grant — text only, no arbitrary clipboard read.
 */
const ALLOWED_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write'];

/**
 * Applies the process-wide security posture. Call once, before any window exists.
 *
 * Nothing in Tabby navigates and nothing in Tabby opens a child window, so both
 * are denied outright. The only escape hatch is an https link handed to the
 * user's real browser.
 */
export function applySecurityGuards(profile: CspProfile): void {
  const policy = profile === 'prod' ? PROD_CSP : DEV_CSP;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  // Explicit allowlist rather than Chromium's defaults: a database viewer has no
  // use for geolocation, camera, microphone or notifications, so denying them
  // outright shrinks the surface instead of relying on an inherited default.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.includes(permission),
  );

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // TODO(Phase 3): restrict to a host allowlist once the app has real links.
      if (url.startsWith('https://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
  });
}
