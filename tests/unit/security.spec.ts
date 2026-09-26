import { describe, expect, it } from 'vitest';
import { DEV_CSP, PROD_CSP } from '../../src/main/security/csp';

describe('production CSP', () => {
  it('never allows unsafe-eval', () => {
    expect(PROD_CSP).not.toContain('unsafe-eval');
  });

  it('restricts script execution to self', () => {
    expect(PROD_CSP).toContain("script-src 'self'");
  });

  it('locks down embedding, objects and form submission', () => {
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(PROD_CSP).toContain(directive);
    }
  });
});

describe('dev CSP', () => {
  it('is a distinct constant, so dev relaxations cannot leak into a build', () => {
    expect(DEV_CSP).not.toEqual(PROD_CSP);
  });

  it('permits the Vite HMR websocket only in dev', () => {
    expect(DEV_CSP).toContain('ws://localhost:*');
    expect(PROD_CSP).not.toContain('ws://localhost:*');
  });
});
