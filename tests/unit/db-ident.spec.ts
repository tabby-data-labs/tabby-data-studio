/**
 * Identifier safety (PLAN Phase 4, ARCHITECTURE §5.6).
 *
 * Tier 1 under AGENTS.md: a pure main-process helper whose behaviour is a
 * function of its inputs. Expectations come from the threat model — every
 * identifier reaching the database originated in a catalog row or in the
 * untrusted renderer — and from how Postgres itself treats identifiers
 * (NAMEDATALEN-1 = 63 bytes, `"` doubled inside a quoted name, NUL truncates).
 */
import { describe, expect, it } from 'vitest';
import {
  IdentifierError,
  MAX_IDENTIFIER_BYTES,
  isGeneratedName,
  quoteIdent,
  quoteQualified,
  unquoteIdent,
} from '../../src/main/db/ident';

describe('quoting', () => {
  it('always wraps in double quotes, even for a plain lowercase name', () => {
    // Always quoting is what makes reserved words and leading digits safe
    // without a keyword list that would have to track every Postgres release.
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('select')).toBe('"select"');
    expect(quoteIdent('0leading_digit')).toBe('"0leading_digit"');
  });

  it('doubles an embedded double quote rather than escaping it with a backslash', () => {
    expect(quoteIdent('with"dquote')).toBe('"with""dquote"');
    expect(quoteIdent('"')).toBe('""""');
    expect(quoteIdent('a""b')).toBe('"a""""b"');
  });

  it('preserves case, spaces and punctuation verbatim', () => {
    expect(quoteIdent('Mixed Case')).toBe('"Mixed Case"');
    expect(quoteIdent('has space')).toBe('"has space"');
    expect(quoteIdent("it's")).toBe(`"it's"`);
    expect(quoteIdent('semi;colon')).toBe('"semi;colon"');
  });

  it('accepts non-ASCII identifiers, which Postgres allows', () => {
    expect(quoteIdent('unicode_ünïcødé')).toBe('"unicode_ünïcødé"');
    expect(quoteIdent('日本語')).toBe('"日本語"');
  });

  it('accepts exactly 63 bytes and rejects 64', () => {
    expect(MAX_IDENTIFIER_BYTES).toBe(63);
    expect(quoteIdent('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
    expect(() => quoteIdent('a'.repeat(64))).toThrow(IdentifierError);
  });

  it('measures the cap in UTF-8 bytes, not characters', () => {
    // Postgres truncates at NAMEDATALEN bytes, so 31 two-byte characters fit and
    // 32 do not — a character count would have allowed a silently-truncated name.
    expect(quoteIdent('ü'.repeat(31))).toBe(`"${'ü'.repeat(31)}"`);
    expect(() => quoteIdent('ü'.repeat(32))).toThrow(IdentifierError);
    expect(() => quoteIdent('日'.repeat(22))).toThrow(IdentifierError); // 66 bytes
    expect(quoteIdent('日'.repeat(21))).toBe(`"${'日'.repeat(21)}"`); // 63 bytes
  });
});

describe('rejection', () => {
  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(IdentifierError);
    expect(() => quoteIdent('   ')).not.toThrow(); // spaces are a legal name
  });

  it('rejects a NUL byte, which would truncate the name server-side', () => {
    expect(() => quoteIdent('users\u0000--')).toThrow(IdentifierError);
    expect(() => quoteIdent('\u0000')).toThrow(IdentifierError);
  });

  it('rejects non-string input instead of coercing it', () => {
    for (const bad of [null, undefined, 42, {}, [], Symbol('x'), true]) {
      expect(() => quoteIdent(bad as unknown as string)).toThrow(IdentifierError);
    }
  });

  it('explains the rejection without echoing a long or hostile payload', () => {
    // The message reaches a log file and possibly the UI, so it must describe
    // the problem, not reproduce attacker-controlled bytes.
    try {
      quoteIdent(`x${'y'.repeat(200)}`);
      expect.unreachable('should have thrown');
    } catch (caught) {
      const message = (caught as IdentifierError).message;
      expect(message).toContain('63');
      expect(message).not.toContain('y'.repeat(100));
    }

    try {
      quoteIdent('bad\u0000name');
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as IdentifierError).message).toMatch(/NUL|\\u0000|nul/i);
    }
  });

  it('tags each rejection with the field it came from', () => {
    try {
      quoteQualified('public', '');
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as IdentifierError).field).toBe('name');
    }
    try {
      quoteQualified('', 'users');
      expect.unreachable('should have thrown');
    } catch (caught) {
      expect((caught as IdentifierError).field).toBe('schema');
    }
  });
});

describe('injection resistance', () => {
  const ATTACKS = [
    'x"; DROP TABLE users; --',
    'x" ; SELECT pg_sleep(10) ; --',
    '"',
    '""',
    'a" OR 1=1 --',
    'tabby_c_1"; CLOSE ALL; --',
    "\\'; DROP TABLE users; --",
    "x\"; COPY (SELECT 1) TO PROGRAM 'rm -rf /'; --",
  ];

  it('produces a balanced quote structure for every attack string', () => {
    for (const attack of ATTACKS) {
      const quoted = quoteIdent(attack);
      expect(quoted.startsWith('"')).toBe(true);
      expect(quoted.endsWith('"')).toBe(true);
      // Inside a quoted identifier, every `"` is either the opening/closing
      // delimiter or part of a doubled pair — so stripping the delimiters must
      // leave an even count.
      const inner = quoted.slice(1, -1);
      expect(inner.length % 2 === 0 || inner.split('"').length % 2 === 1).toBe(true);
      expect(inner.replace(/""/g, '')).not.toContain('"');
    }
  });

  it('never lets an attack survive a quote/unquote round trip changed', () => {
    for (const attack of ATTACKS) {
      expect(unquoteIdent(quoteIdent(attack))).toBe(attack);
    }
  });
});

describe('unquoteIdent', () => {
  it('reverses quoting for ordinary names', () => {
    expect(unquoteIdent('"users"')).toBe('users');
    expect(unquoteIdent('"Mixed Case"')).toBe('Mixed Case');
    expect(unquoteIdent('"with""dquote"')).toBe('with"dquote');
  });

  it('passes an unquoted name through unchanged', () => {
    expect(unquoteIdent('users')).toBe('users');
  });

  it('rejects a malformed quoted name rather than guessing', () => {
    expect(() => unquoteIdent('"unterminated')).toThrow(IdentifierError);
    expect(() => unquoteIdent('leading"')).toThrow(IdentifierError);
  });
});

describe('quoteQualified', () => {
  it('quotes both parts of a schema-qualified name', () => {
    expect(quoteQualified('public', 'users')).toBe('"public"."users"');
    expect(quoteQualified('Mixed Case', 'with"dquote')).toBe('"Mixed Case"."with""dquote"');
  });

  it('rejects an empty schema or name', () => {
    expect(() => quoteQualified('', 'users')).toThrow(IdentifierError);
    expect(() => quoteQualified('public', '')).toThrow(IdentifierError);
  });

  it('treats a dot as an ordinary character, never as a qualifier separator', () => {
    // Callers must pass schema and table separately; quoting a pre-joined
    // "public.users" would produce one identifier containing a dot.
    expect(quoteQualified('public', 'a.b')).toBe('"public"."a.b"');
  });

  it('refuses to unquote a two-part name, so it cannot invent a joined identifier', () => {
    expect(() => unquoteIdent('"public"."users"')).toThrow(IdentifierError);
  });
});

describe('isGeneratedName', () => {
  it('accepts the conservative alphabet used for names Tabby invents', () => {
    expect(isGeneratedName('tabby_c_1')).toBe(true);
    expect(isGeneratedName('_private')).toBe(true);
    expect(isGeneratedName('a$1')).toBe(true);
    expect(isGeneratedName('A_9')).toBe(true);
  });

  it('rejects anything needing quotes, so generated names never do', () => {
    for (const bad of [
      '',
      '1leading',
      'has space',
      'dash-ed',
      'quote"d',
      'ünicode',
      'semi;colon',
      'a'.repeat(64),
    ]) {
      expect(isGeneratedName(bad), bad).toBe(false);
    }
  });
});
