/**
 * Postgres type handling that must not depend on the machine's timezone, on
 * `pg`'s default parsers, or on a JS double having enough precision
 * (PLAN Phase 4, ARCHITECTURE §5.4).
 *
 * The two traps this module exists to close:
 *
 *  - `timestamp without time zone` parsed by `new Date(text)` is read in the
 *    *host* timezone, so the same row renders an hour apart after a flight. The
 *    parser here is explicit about reading the wall clock as UTC.
 *  - `int8` and `numeric` exceed 2^53. They stay text from the wire to the cell;
 *    converting them to a number rounds silently, which is the worst kind of bug
 *    in a data viewer because the result still looks plausible.
 *
 * Nothing here imports `pg`. `driver-pg.ts` registers these functions as type
 * parsers, which is what keeps the codec testable without a database.
 */

/** OIDs fixed by `pg_type.dat`. Only the ones Tabby treats specially. */
export const OID = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  point: 600,
  float4: 700,
  float8: 701,
  money: 790,
  boolArray: 1000,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  int4Array: 1007,
  textArray: 1009,
  timestamp: 1114,
  timetz: 1185,
  timestamptz: 1184,
  interval: 1186,
  float8Array: 1022,
  numericArray: 1231,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
} as const;

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [OID.bool]: 'bool',
  [OID.bytea]: 'bytea',
  [OID.char]: 'char',
  [OID.name]: 'name',
  [OID.int8]: 'int8',
  [OID.int2]: 'int2',
  [OID.int4]: 'int4',
  [OID.text]: 'text',
  [OID.oid]: 'oid',
  [OID.json]: 'json',
  [OID.xml]: 'xml',
  [OID.point]: 'point',
  [OID.float4]: 'float4',
  [OID.float8]: 'float8',
  [OID.money]: 'money',
  [OID.boolArray]: '_bool',
  [OID.bpchar]: 'bpchar',
  [OID.varchar]: 'varchar',
  [OID.date]: 'date',
  [OID.time]: 'time',
  [OID.int4Array]: '_int4',
  [OID.textArray]: '_text',
  [OID.timestamp]: 'timestamp',
  [OID.timetz]: 'timetz',
  [OID.timestamptz]: 'timestamptz',
  [OID.interval]: 'interval',
  [OID.float8Array]: '_float8',
  [OID.numericArray]: '_numeric',
  [OID.numeric]: 'numeric',
  [OID.uuid]: 'uuid',
  [OID.jsonb]: 'jsonb',
};

/** How a column of this type is packed for transfer (ARCHITECTURE §5.4). */
export type EncodingKind = 'float64' | 'utf8' | 'bits';

const FLOAT64_TYPES: ReadonlySet<number> = new Set([
  OID.int2,
  OID.int4,
  OID.float4,
  OID.float8,
  OID.timestamp,
  OID.timestamptz,
]);

/** json and jsonb: text that happens to be structured, not a Postgres array. */
const JSON_OIDS: ReadonlySet<number> = new Set([OID.json, OID.jsonb]);

export function typeNameFor(oid: number): string {
  return TYPE_NAMES[oid] ?? `oid:${oid}`;
}

/**
 * `date` is deliberately *not* in the float64 set: a calendar date has no
 * timezone, so an epoch-millisecond encoding would render `2026-10-01` as
 * `2026-09-30` anywhere west of Greenwich.
 */
export function encodingKindFor(oid: number): EncodingKind {
  if (oid === OID.bool) return 'bits';
  if (FLOAT64_TYPES.has(oid)) return 'float64';
  return 'utf8';
}

/**
 * True for the types whose float64 payload is an instant rather than a quantity.
 * Decoders need to know: an epoch-millisecond `int4` is a number, an
 * epoch-millisecond `timestamptz` is a moment in time.
 */
export function isTemporalOid(oid: number): boolean {
  return oid === OID.timestamp || oid === OID.timestamptz;
}

const WIDTH_HINTS: Readonly<Record<number, number>> = {
  [OID.bool]: 64,
  [OID.char]: 80,
  [OID.int2]: 72,
  [OID.int4]: 90,
  [OID.oid]: 90,
  [OID.float4]: 100,
  [OID.money]: 110,
  [OID.time]: 100,
  [OID.date]: 110,
  [OID.float8]: 120,
  [OID.int8]: 130,
  [OID.timetz]: 130,
  [OID.bytea]: 140,
  [OID.bpchar]: 140,
  [OID.numeric]: 140,
  [OID.interval]: 150,
  [OID.name]: 160,
  [OID.timestamp]: 170,
  [OID.timestamptz]: 200,
  [OID.uuid]: 300,
};

const DEFAULT_WIDTH_HINT = 150;
const WIDE_TYPES: ReadonlySet<number> = new Set([
  OID.text,
  OID.varchar,
  OID.json,
  OID.jsonb,
  OID.xml,
  OID.point,
]);
const WIDE_WIDTH_HINT = 220;
const ARRAY_WIDTH_HINT = 180;

/** Suggested initial column width in CSS pixels, consumed by the grid. */
export function widthHintFor(oid: number): number {
  const explicit = WIDTH_HINTS[oid];
  if (explicit !== undefined) return explicit;
  if (WIDE_TYPES.has(oid)) return WIDE_WIDTH_HINT;
  if (oid >= 1000 && oid <= 1999) return ARRAY_WIDTH_HINT;
  return DEFAULT_WIDTH_HINT;
}

// ── Timestamp and date parsers ───────────────────────────────────────────────

const TIMESTAMP_PATTERN =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})$/;
const INFINITY_PATTERN = /^(-?)infinity$/i;

/**
 * Fractional seconds as an integer millisecond count.
 *
 * Parsed from the digits rather than via `Number('.029') * 1000`, which yields
 * 28.999999999999996 and truncates to 28 — a visible one-millisecond lie.
 */
function fractionMs(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  return Number(fraction.slice(1).padEnd(3, '0').slice(0, 3));
}

/**
 * Builds an epoch-millisecond value from explicit UTC parts.
 *
 * `setUTCFullYear` rather than `Date.UTC`: the latter maps years 0–99 onto
 * 1900–1999, which would move an ancient timestamp by nineteen centuries. The
 * read-back comparison rejects dates Postgres can store but that would silently
 * roll over (`2026-02-31`).
 */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, ms);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function offsetMinutes(offset: string): number {
  const body = offset.slice(1).replace(':', '');
  const hours = Number(body.slice(0, 2));
  const minutes = Number(body.slice(2, 4) || '0');
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Reads a `timestamp without time zone` as the UTC wall clock it displays, plus
 * an optional explicit offset when the server sent one.
 *
 * Returns ±Infinity for Postgres' two infinities: turning them into NULL would
 * lose a value the user can see in psql.
 */
export function parseTimestampAsUtc(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const infinity = INFINITY_PATTERN.exec(trimmed);
  if (infinity) return infinity[1] === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;

  const match = TIMESTAMP_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, year, month, day, hours, minutes, seconds, fraction, offset] = match;
  const base = utcFromParts(
    Number(year),
    Number(month),
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds ?? '0'),
    fractionMs(fraction),
  );
  if (base === null) return null;
  if (offset === undefined || offset === 'Z') return base;
  return base - offsetMinutes(offset) * 60_000;
}

/**
 * Returns the calendar date as text. Deliberately not a `Date`: a bare date has
 * no timezone, and any `Date` built from it is midnight *somewhere*, which is the
 * previous day anywhere west of that somewhere.
 */
export function parseDateOnly(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (INFINITY_PATTERN.test(trimmed)) return trimmed;

  const match = DATE_PATTERN.exec(trimmed);
  if (!match) return null;
  const [, year, month, day] = match;
  if (utcFromParts(Number(year), Number(month), Number(day), 0, 0, 0, 0) === null) return null;
  return trimmed;
}

// ── Value normalisation ──────────────────────────────────────────────────────

export type NormalizedValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'bytes'; readonly value: Uint8Array };

const NULL_VALUE: NormalizedValue = { kind: 'null' };

const TRUE_SPELLINGS: ReadonlySet<string> = new Set(['t', 'true', '1', 'yes', 'on', 'y']);
const FALSE_SPELLINGS: ReadonlySet<string> = new Set(['f', 'false', '0', 'no', 'off', 'n']);
const HEX_PATTERN = /^\\?x([0-9a-fA-F]*)$/;

function decodeHexText(text: string): Uint8Array | null {
  const match = HEX_PATTERN.exec(text);
  if (!match) return null;
  const hex = match[1] ?? '';
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const HEX_DIGITS = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 0x0f);
  }
  return out;
}

/**
 * Reduces whatever `pg` handed back to one of five shapes the codec can pack.
 *
 * The `oid` is used only where the JS type is ambiguous: a boolean that arrived
 * as `'t'`, and a `bytea` that arrived as Postgres hex text. Everything else is
 * dispatched on the JS type, which is already unambiguous.
 */
export function normalizeValue(oid: number, value: unknown): NormalizedValue {
  if (value === null || value === undefined) return NULL_VALUE;

  if (typeof value === 'boolean') return { kind: 'bool', value };

  if (typeof value === 'string') {
    if (oid === OID.bool) {
      const spelling = value.trim().toLowerCase();
      if (TRUE_SPELLINGS.has(spelling)) return { kind: 'bool', value: true };
      if (FALSE_SPELLINGS.has(spelling)) return { kind: 'bool', value: false };
      // An unrecognised spelling is data. Guessing `false` would invent a value.
    }
    if (oid === OID.bytea) {
      const bytes = decodeHexText(value);
      if (bytes !== null) return { kind: 'bytes', value: bytes };
    }
    return { kind: 'text', value };
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { kind: 'num', value };
    if (Number.isNaN(value)) return { kind: 'text', value: 'NaN' };
    // float8 and the temporal types both have infinities in Postgres, and they
    // print them differently: `Infinity` for float8, `infinity` for a timestamp.
    // Preserved as the type's own spelling so a copy/paste round-trips into SQL.
    const negative = value < 0;
    if (isTemporalOid(oid)) return { kind: 'text', value: negative ? '-infinity' : 'infinity' };
    return { kind: 'text', value: negative ? '-Infinity' : 'Infinity' };
  }

  if (typeof value === 'bigint') return { kind: 'text', value: value.toString() };

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time)
      ? { kind: 'text', value: 'Invalid Date' }
      : { kind: 'num', value: time };
  }

  if (value instanceof Uint8Array) return { kind: 'bytes', value };

  if (ArrayBuffer.isView(value)) {
    return {
      kind: 'bytes',
      value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    };
  }

  if (typeof value === 'object') {
    // A JS array means different things for different OIDs: for a Postgres array
    // column it is `{1,2}` (which pastes back into SQL), for json/jsonb it is
    // `[1,2]`. The driver keeps json as server text via an identity parser, so the
    // json branch is a fallback for a parser change rather than the common path —
    // but rendering JSON data as a Postgres array literal would be wrong either way.
    if (Array.isArray(value)) {
      return {
        kind: 'text',
        value: JSON_OIDS.has(oid) ? JSON.stringify(value) : arrayLiteral(value),
      };
    }
    try {
      return { kind: 'text', value: JSON.stringify(value) };
    } catch {
      // A jsonb column cannot normally hold a cycle, but a custom parser or a
      // future driver change could produce one, and throwing here would lose the
      // whole window.
      return { kind: 'text', value: '[circular]' };
    }
  }

  return { kind: 'text', value: String(value) };
}

/** Characters that make an unquoted array element ambiguous. */
const ARRAY_UNSAFE = /[{},\\" \t\n\r]/;

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return arrayLiteral(value);
  const text = typeof value === 'string' ? value : String(value);
  if (text !== '' && !ARRAY_UNSAFE.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function arrayLiteral(values: readonly unknown[]): string {
  return `{${values.map(arrayElement).join(',')}}`;
}

/** The display text for a normalized value. Hex for bytes, matching psql. */
export function textFor(value: NormalizedValue): string {
  switch (value.kind) {
    case 'null':
      return '';
    case 'num':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'text':
      return value.value;
    case 'bytes':
      return toHex(value.value);
  }
}
