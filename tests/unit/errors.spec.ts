import { describe, expect, it } from 'vitest';
import { err, ok, scrub } from '../../src/shared/errors';

describe('Result helpers', () => {
  it('ok() narrows to a value', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('err() carries a stable code', () => {
    const result = err<number>({ code: 'INTERNAL', message: 'boom' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INTERNAL');
    }
  });
});

describe('scrub()', () => {
  it('redacts credentials embedded in driver error text', () => {
    expect(scrub('connection failed password=hunter2 host=db.local')).toBe(
      'connection failed password=[redacted] host=db.local',
    );
  });

  it('redacts token and secret fragments', () => {
    expect(scrub('token=abc123 secret=xyz')).toBe('token=[redacted] secret=[redacted]');
  });

  it('leaves ordinary Postgres errors untouched', () => {
    const message = 'relation "users" does not exist';
    expect(scrub(message)).toBe(message);
  });
});
