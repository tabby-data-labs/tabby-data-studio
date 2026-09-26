const BASE_DIRECTIVES = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/**
 * Production policy. No `unsafe-eval`: Vue 3's runtime-only build compiles SFCs
 * ahead of time, so nothing needs to evaluate a string.
 *
 * `style-src 'unsafe-inline'` is required because Vue sets inline styles and
 * Tailwind's runtime injects style tags. It is the one deliberate relaxation.
 */
export const PROD_CSP = [
  ...BASE_DIRECTIVES,
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

/**
 * Development policy. Vite's HMR needs a websocket back to the dev server and
 * `unsafe-eval` for its module graph. Kept as a separate constant so relaxing
 * dev can never leak into a shipped build.
 */
export const DEV_CSP = [
  ...BASE_DIRECTIVES,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
].join('; ');
