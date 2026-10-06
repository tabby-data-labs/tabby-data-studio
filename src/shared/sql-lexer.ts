/**
 * A Postgres lexer (PLAN Phase 7).
 *
 * Implements the lexical rules of §4.1 of the Postgres manual:
 *  - `'…'` standard string, `''` escapes, backslash is **not** an escape
 *    (`standard_conforming_strings` has been on by default since 9.1)
 *  - `E'…'` escape string, where `\'` **is** an escape
 *  - `"…"` quoted identifier, `""` escapes
 *  - `-- …` line comment
 *  - block comment, which **nests**
 *  - `$tag$ … $tag$` dollar quoting, tag optional
 *  - `$1` positional parameter, which must not be read as a dollar-quote opener
 *
 * It lives in `src/shared` because two consumers need the *same* answer and must
 * not be allowed to drift: the editor highlights with it, and
 * `src/main/db/sql-scan.ts` — the security control that decides whether
 * renderer-supplied SQL may be wrapped in `DECLARE … CURSOR FOR` — is built on top
 * of it. Two lexers would eventually split a script differently from how main
 * validates it, and the failure would look like a server error.
 *
 * **Never throws.** A half-typed query is the normal state of an editor, so an
 * unterminated construct is reported in `error` and the token runs to the end of
 * the input. Callers that must refuse such input — main — check `error` and throw
 * their own typed exception.
 *
 * **Tokens tile the input.** Every character belongs to exactly one token, in
 * order, with no gaps and no overlaps. That is what lets a highlight layer be laid
 * behind a textarea and stay aligned with it; `tests/unit/sql-lexer.spec.ts`
 * asserts it over a corpus rather than once.
 *
 * Not handled, and cosmetic where it matters: the `B'…'`, `X'…'`, `N'…'` and
 * `U&'…'` string prefixes lex as an identifier followed by a string. None of them
 * changes where a `;` falls — they behave like standard strings — so statement
 * splitting is unaffected.
 */

export type TokenKind =
  | 'whitespace'
  | 'lineComment'
  | 'blockComment'
  | 'string'
  | 'escapeString'
  | 'dollarString'
  | 'quotedIdent'
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'operator'
  | 'punctuation'
  | 'semicolon'
  | 'parameter';

export interface Token {
  readonly kind: TokenKind;
  /** Inclusive offset into the source. */
  readonly start: number;
  /** Exclusive offset into the source. Always greater than `start`. */
  readonly end: number;
}

export interface LexError {
  readonly message: string;
  /** Offset the problem starts at, so an editor can point at it. */
  readonly at: number;
}

export interface LexResult {
  readonly tokens: readonly Token[];
  /** The first problem found, or null. Tokens are still complete and usable. */
  readonly error: LexError | null;
}

/**
 * Postgres keywords, lowercase.
 *
 * A `Set`, not an object literal: `KEYWORDS['constructor']` on a plain object
 * would resolve through the prototype and colour every identifier named
 * `constructor` as a keyword. Misclassification here is cosmetic — structure
 * depends only on quoting, comments and semicolons — but it is cheap to get right.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'abort',
  'absolute',
  'access',
  'action',
  'add',
  'admin',
  'after',
  'aggregate',
  'all',
  'also',
  'alter',
  'always',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'assertion',
  'assignment',
  'asymmetric',
  'at',
  'attach',
  'attribute',
  'authorization',
  'backward',
  'before',
  'begin',
  'between',
  'bigint',
  'binary',
  'bit',
  'boolean',
  'both',
  'by',
  'cache',
  'call',
  'called',
  'cascade',
  'cascaded',
  'case',
  'cast',
  'catalog',
  'chain',
  'char',
  'character',
  'characteristics',
  'check',
  'checkpoint',
  'class',
  'close',
  'cluster',
  'coalesce',
  'collate',
  'collation',
  'column',
  'columns',
  'comment',
  'comments',
  'commit',
  'committed',
  'compression',
  'concurrently',
  'configuration',
  'conflict',
  'connection',
  'constraint',
  'constraints',
  'content',
  'continue',
  'conversion',
  'copy',
  'cost',
  'create',
  'cross',
  'csv',
  'cube',
  'current',
  'cursor',
  'cycle',
  'data',
  'database',
  'day',
  'deallocate',
  'dec',
  'decimal',
  'declare',
  'default',
  'defaults',
  'deferrable',
  'deferred',
  'definer',
  'delete',
  'delimiter',
  'delimiters',
  'depends',
  'desc',
  'detach',
  'dictionary',
  'disable',
  'discard',
  'distinct',
  'do',
  'document',
  'domain',
  'double',
  'drop',
  'each',
  'else',
  'enable',
  'encoding',
  'encrypted',
  'end',
  'enum',
  'escape',
  'event',
  'except',
  'exclude',
  'excluding',
  'exclusive',
  'execute',
  'exists',
  'explain',
  'expression',
  'extension',
  'external',
  'extract',
  'false',
  'family',
  'fetch',
  'filter',
  'first',
  'float',
  'following',
  'for',
  'force',
  'foreign',
  'forward',
  'freeze',
  'from',
  'full',
  'function',
  'functions',
  'generated',
  'global',
  'grant',
  'granted',
  'greatest',
  'group',
  'grouping',
  'groups',
  'handler',
  'having',
  'header',
  'hold',
  'hour',
  'identity',
  'if',
  'ilike',
  'immediate',
  'immutable',
  'implicit',
  'import',
  'in',
  'include',
  'including',
  'increment',
  'index',
  'indexes',
  'inherit',
  'inherits',
  'initially',
  'inline',
  'inner',
  'inout',
  'input',
  'insensitive',
  'insert',
  'instead',
  'int',
  'integer',
  'intersect',
  'interval',
  'into',
  'invoker',
  'is',
  'isolation',
  'join',
  'key',
  'label',
  'language',
  'large',
  'last',
  'lateral',
  'leading',
  'leakproof',
  'least',
  'left',
  'level',
  'like',
  'limit',
  'listen',
  'load',
  'local',
  'localtime',
  'localtimestamp',
  'location',
  'lock',
  'locked',
  'logged',
  'mapping',
  'match',
  'materialized',
  'maxvalue',
  'method',
  'minute',
  'minvalue',
  'mode',
  'month',
  'move',
  'name',
  'names',
  'national',
  'natural',
  'nchar',
  'new',
  'next',
  'no',
  'none',
  'normalize',
  'not',
  'nothing',
  'notify',
  'notnull',
  'nowait',
  'null',
  'nullif',
  'nulls',
  'numeric',
  'object',
  'of',
  'off',
  'offset',
  'oids',
  'old',
  'on',
  'only',
  'operator',
  'option',
  'options',
  'or',
  'order',
  'ordinality',
  'others',
  'out',
  'outer',
  'over',
  'overlaps',
  'overlay',
  'overriding',
  'owned',
  'owner',
  'parallel',
  'parser',
  'partial',
  'partition',
  'passing',
  'password',
  'placing',
  'plans',
  'policy',
  'position',
  'preceding',
  'precision',
  'prepare',
  'prepared',
  'preserve',
  'primary',
  'prior',
  'privileges',
  'procedural',
  'procedure',
  'procedures',
  'program',
  'publication',
  'quote',
  'range',
  'read',
  'real',
  'reassign',
  'recheck',
  'recursive',
  'ref',
  'references',
  'referencing',
  'refresh',
  'reindex',
  'relative',
  'release',
  'rename',
  'repeatable',
  'replace',
  'replica',
  'reset',
  'restart',
  'restrict',
  'return',
  'returning',
  'returns',
  'revoke',
  'right',
  'role',
  'rollback',
  'rollup',
  'routine',
  'routines',
  'row',
  'rows',
  'rule',
  'savepoint',
  'schema',
  'schemas',
  'scroll',
  'search',
  'second',
  'security',
  'select',
  'sequence',
  'sequences',
  'serializable',
  'server',
  'session',
  'set',
  'setof',
  'sets',
  'share',
  'show',
  'similar',
  'simple',
  'skip',
  'smallint',
  'snapshot',
  'some',
  'sql',
  'stable',
  'standalone',
  'start',
  'statement',
  'statistics',
  'stdin',
  'stdout',
  'storage',
  'stored',
  'strict',
  'strip',
  'subscription',
  'substring',
  'support',
  'symmetric',
  'sysid',
  'system',
  'table',
  'tables',
  'tablesample',
  'tablespace',
  'temp',
  'template',
  'temporary',
  'text',
  'then',
  'ties',
  'time',
  'timestamp',
  'to',
  'trailing',
  'transaction',
  'transform',
  'treat',
  'trigger',
  'trim',
  'true',
  'truncate',
  'trusted',
  'type',
  'types',
  'uescape',
  'unbounded',
  'uncommitted',
  'unencrypted',
  'union',
  'unique',
  'unknown',
  'unlisten',
  'unlogged',
  'until',
  'update',
  'user',
  'using',
  'vacuum',
  'valid',
  'validate',
  'validator',
  'value',
  'values',
  'varchar',
  'variadic',
  'varying',
  'verbose',
  'version',
  'view',
  'views',
  'volatile',
  'when',
  'where',
  'whitespace',
  'window',
  'with',
  'within',
  'without',
  'work',
  'wrapper',
  'write',
  'xml',
  'xmlattributes',
  'xmlconcat',
  'xmlelement',
  'xmlexists',
  'xmlforest',
  'xmlnamespaces',
  'xmlparse',
  'xmlpi',
  'xmlroot',
  'xmlserialize',
  'xmltable',
  'year',
  'yes',
  'zone',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word.toLowerCase());
}

/**
 * Postgres builds operators from any run of these characters, and user-defined
 * operators can be arbitrary (`<<>>`, `#>@`). Taking the maximal run is both
 * correct and simpler than a table of the built-in ones.
 *
 * `:` is not in the manual's list but has to be here: without it the cast operator
 * `::` lexes as two one-character operators, and `a::text` colours as three
 * unrelated tokens. A bare `:` has no other meaning at statement level, and
 * PL/pgSQL's `:=` wants the same treatment.
 */
const OPERATOR_CHARS = '+-*/<>=~!@#%^&|?:';

const TAG_FIRST = /[A-Za-z_]/;
const TAG_REST = /[A-Za-z0-9_]/;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/** Letters, digits, `_` and `$` continue an identifier; `$` may not start one. */
function isIdentContinue(ch: string): boolean {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  // Everything at or above 0x80 counts as a letter: Postgres accepts non-ASCII
  // identifiers, and `日本語` must be one token, not three.
  return (
    code >= 0x80 ||
    ch === '_' ||
    ch === '$' ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isIdentStart(ch: string): boolean {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  return code >= 0x80 || ch === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Index just past the closing quote, or -1 when the literal runs to end of input.
 *
 * `charAt` rather than `sql[i]`: past the end it yields `''`, which is never a
 * valid SQL character, so running off the end takes the same branch as a syntax
 * error instead of an undefined comparison.
 */
function scanQuoted(sql: string, start: number, quote: string, escapes: boolean): number {
  let i = start + 1;
  for (;;) {
    const ch = sql.charAt(i);
    if (ch === '') return -1;
    if (escapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      // A doubled quote is an escaped quote and does not close the literal.
      if (sql.charAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
}

/**
 * The dollar-quote tag at `start`, or null when the `$` is not a dollar-quote
 * opener. `''` is the untagged `$$` form.
 */
function dollarTagAt(sql: string, start: number): string | null {
  if (sql.charAt(start) !== '$') return null;
  const first = sql.charAt(start + 1);
  if (first === '$') return '';
  if (!TAG_FIRST.test(first)) return null;

  let last = start + 1;
  while (TAG_REST.test(sql.charAt(last + 1))) last += 1;
  if (sql.charAt(last + 1) !== '$') return null;
  return sql.slice(start + 1, last + 1);
}

/**
 * Lexes `sql`.
 *
 * Total: it returns a result for every input, including non-strings, and reports
 * problems in `error` rather than throwing.
 */
export function lex(sql: string): LexResult {
  if (typeof sql !== 'string') return { tokens: [], error: null };

  const tokens: Token[] = [];
  // Checked before lexing, not while scanning: Postgres rejects a NUL anywhere in
  // the query text because the text is a C string, so one buried inside a literal
  // is just as fatal as one at top level — and reporting the literal as
  // "unterminated" instead would send the user to fix the wrong thing.
  const nul = sql.indexOf('\u0000');
  let error: LexError | null =
    nul >= 0 ? { message: 'must not contain a NUL byte', at: nul } : null;

  const fail = (message: string, at: number): void => {
    if (error === null) error = { message, at };
  };

  const length = sql.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, start, end });
  };

  while (i < length) {
    const ch = sql.charAt(i);

    if (isWhitespace(ch)) {
      let j = i + 1;
      while (j < length && isWhitespace(sql.charAt(j))) j += 1;
      push('whitespace', i, j);
      i = j;
      continue;
    }

    if (ch === '-' && sql.charAt(i + 1) === '-') {
      const newline = sql.indexOf('\n', i + 2);
      let end = newline < 0 ? length : newline;
      // The CR of a CRLF belongs to the line break, not to the comment, so the
      // highlighted run and the whitespace run meet cleanly.
      if (end > i + 2 && sql.charAt(end - 1) === '\r') end -= 1;
      push('lineComment', i, end);
      i = end;
      continue;
    }

    if (ch === '/' && sql.charAt(i + 1) === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        if (sql.charAt(j) === '/' && sql.charAt(j + 1) === '*') {
          depth += 1;
          j += 2;
        } else if (sql.charAt(j) === '*' && sql.charAt(j + 1) === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) {
        fail('unterminated block comment', i);
        push('blockComment', i, length);
        i = length;
      } else {
        push('blockComment', i, j);
        i = j;
      }
      continue;
    }

    if (ch === "'") {
      const end = scanQuoted(sql, i, "'", false);
      if (end < 0) {
        fail('unterminated quoted literal', i);
        push('string', i, length);
        i = length;
      } else {
        push('string', i, end);
        i = end;
      }
      continue;
    }

    // E'…' / e'…' — the backslash escapes only in this form, so the two string
    // syntaxes genuinely differ and must not share a branch. The prefix only counts
    // when it *starts* a token: in `fooE'x'` the `E` is the last character of an
    // identifier, and reading it as a prefix would change where the string ends.
    if (
      (ch === 'E' || ch === 'e') &&
      sql.charAt(i + 1) === "'" &&
      (i === 0 || !isIdentContinue(sql.charAt(i - 1)))
    ) {
      const end = scanQuoted(sql, i + 1, "'", true);
      if (end < 0) {
        fail('unterminated quoted literal', i);
        push('escapeString', i, length);
        i = length;
      } else {
        push('escapeString', i, end);
        i = end;
      }
      continue;
    }

    if (ch === '"') {
      const end = scanQuoted(sql, i, '"', false);
      if (end < 0) {
        fail('unterminated quoted literal', i);
        push('quotedIdent', i, length);
        i = length;
      } else {
        push('quotedIdent', i, end);
        i = end;
      }
      continue;
    }

    if (ch === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag !== null) {
        const delimiter = `$${tag}$`;
        const close = sql.indexOf(delimiter, i + delimiter.length);
        if (close < 0) {
          fail('unterminated dollar-quoted body', i);
          push('dollarString', i, length);
          i = length;
        } else {
          push('dollarString', i, close + delimiter.length);
          i = close + delimiter.length;
        }
        continue;
      }
      if (isDigit(sql.charAt(i + 1))) {
        let j = i + 1;
        while (isDigit(sql.charAt(j))) j += 1;
        push('parameter', i, j);
        i = j;
        continue;
      }
      push('operator', i, i + 1);
      i += 1;
      continue;
    }

    if (ch === ';') {
      push('semicolon', i, i + 1);
      i += 1;
      continue;
    }

    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',' || ch === '.') {
      // A `.` followed by a digit is the start of a number, handled below.
      if (!(ch === '.' && isDigit(sql.charAt(i + 1)))) {
        push('punctuation', i, i + 1);
        i += 1;
        continue;
      }
    }

    if (isDigit(ch) || (ch === '.' && isDigit(sql.charAt(i + 1)))) {
      let j = i;
      // The leading `while` also covers `.5`, where it simply does not advance.
      while (isDigit(sql.charAt(j))) j += 1;
      if (sql.charAt(j) === '.' && isDigit(sql.charAt(j + 1))) {
        j += 1;
        while (isDigit(sql.charAt(j))) j += 1;
      }
      const exponent = sql.charAt(j);
      if ((exponent === 'e' || exponent === 'E') && /[0-9+-]/.test(sql.charAt(j + 1))) {
        j += 1;
        if (sql.charAt(j) === '+' || sql.charAt(j) === '-') j += 1;
        while (isDigit(sql.charAt(j))) j += 1;
      }
      push('number', i, j);
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (isIdentContinue(sql.charAt(j))) j += 1;
      const word = sql.slice(i, j);
      push(isKeyword(word) ? 'keyword' : 'identifier', i, j);
      i = j;
      continue;
    }

    if (OPERATOR_CHARS.includes(ch)) {
      let j = i + 1;
      // `-` and `/` cannot extend a run into `--` or `/*`: both were handled above
      // only at the *start* of a token, and an operator run that swallowed them
      // would turn a comment into punctuation.
      while (j < length) {
        const next = sql.charAt(j);
        if (!OPERATOR_CHARS.includes(next)) break;
        if (next === '-' && sql.charAt(j + 1) === '-') break;
        if (next === '/' && sql.charAt(j + 1) === '*') break;
        j += 1;
      }
      push('operator', i, j);
      i = j;
      continue;
    }

    // Anything else — a stray control character, a symbol with no SQL meaning. One
    // token per character keeps the tiling invariant without inventing a category.
    push('operator', i, i + 1);
    i += 1;
  }

  return { tokens, error };
}
