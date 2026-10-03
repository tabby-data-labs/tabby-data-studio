/**
 * Identifier quoting (PLAN Phase 4, ARCHITECTURE §5.6).
 *
 * Every object name that reaches the database came from either a catalog row or
 * the untrusted renderer. Both are treated the same way: always quote, double
 * any embedded `"`, and refuse the two things Postgres cannot represent — a NUL
 * byte (which truncates the name server-side) and anything longer than
 * NAMEDATALEN-1 = 63 *bytes* (which Postgres would truncate silently).
 *
 * Deviation from ARCHITECTURE §5.6, deliberate: the doc proposes rejecting
 * anything outside `[A-Za-z0-9_$]`. That allowlist is right for names *Tabby
 * invents* (cursor names, temp tables) and wrong for names that *came from the
 * server* — Postgres happily stores `Mixed Case`, `has space`, `with"dquote` and
 * `unicode_ünïcødé`, and refusing them would make real databases unbrowsable
 * without making anything safer. So there are two functions with two contracts:
 * `quoteIdent` for names that exist, `isGeneratedName` for names we create.
 */

/** Postgres truncates identifiers at NAMEDATALEN-1, measured in bytes. */
export const MAX_IDENTIFIER_BYTES = 63;

/** Names Tabby invents. Conservative on purpose: they never need quoting. */
const GENERATED_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const encoder = new TextEncoder();

export class IdentifierError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(field === '' ? message : `${field}: ${message}`);
    this.name = 'IdentifierError';
    this.field = field;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Never interpolates the offending value into the message: these errors are
 * logged and can be shown in the UI, so echoing attacker-controlled bytes would
 * turn an identifier into an injection vector for the log itself.
 */
function checked(name: unknown, field: string): string {
  if (typeof name !== 'string') {
    throw new IdentifierError(field, `expected a string, received ${describeType(name)}`);
  }
  if (name.length === 0) {
    throw new IdentifierError(field, 'must not be empty');
  }
  if (name.includes('\u0000')) {
    throw new IdentifierError(field, 'must not contain a NUL byte');
  }
  const bytes = encoder.encode(name).length;
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new IdentifierError(
      field,
      `is ${bytes} bytes, over the ${MAX_IDENTIFIER_BYTES}-byte Postgres limit`,
    );
  }
  return name;
}

/** Quotes a name that exists (catalog or user supplied). Always safe to embed. */
export function quoteIdent(name: string, field = 'identifier'): string {
  return `"${checked(name, field).replace(/"/g, '""')}"`;
}

/** Quotes a schema-qualified pair. Never accepts a pre-joined `schema.table`. */
export function quoteQualified(schema: string, name: string): string {
  return `${quoteIdent(schema, 'schema')}.${quoteIdent(name, 'name')}`;
}

/**
 * Inverse of `quoteIdent`, for the rare case where a quoted name arrives as text.
 * Refuses anything ambiguous rather than guessing: a bare name containing `"`, or
 * a quoted name with an unpaired `"` inside, is malformed and not worth repairing.
 */
export function unquoteIdent(quoted: string, field = 'identifier'): string {
  if (typeof quoted !== 'string') {
    throw new IdentifierError(field, `expected a string, received ${describeType(quoted)}`);
  }

  if (!quoted.startsWith('"')) {
    if (quoted.includes('"')) {
      throw new IdentifierError(field, 'unquoted identifier must not contain a double quote');
    }
    return quoted;
  }

  if (quoted.length < 2 || !quoted.endsWith('"')) {
    throw new IdentifierError(field, 'unterminated quoted identifier');
  }

  const inner = quoted.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '"') continue;
    if (inner[i + 1] !== '"') {
      throw new IdentifierError(field, 'malformed quoted identifier: unpaired double quote');
    }
    i += 1;
  }
  return inner.replace(/""/g, '"');
}

/** True when a name needs no quoting and cannot collide with anything. */
export function isGeneratedName(name: unknown): boolean {
  return (
    typeof name === 'string' && name.length <= MAX_IDENTIFIER_BYTES && GENERATED_NAME.test(name)
  );
}

/**
 * Validates a name Tabby generated before it is interpolated into DDL-ish SQL
 * (`DECLARE <name> CURSOR`). Throwing here means a bug in name generation fails
 * loudly instead of producing a malformed statement.
 */
export function assertGeneratedName(name: string, field = 'generated'): string {
  if (!isGeneratedName(name)) {
    throw new IdentifierError(field, 'is not a valid generated identifier');
  }
  return name;
}
