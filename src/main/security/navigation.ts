import { app, session, shell } from 'electron';
import { DEV_CSP, PROD_CSP } from './csp';

export type CspProfile = 'prod' | 'dev';

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
