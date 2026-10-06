/**
 * DDL generation for the Phase 6 detail pane.
 *
 * This is a **reading aid, not a migration tool.** It reproduces what a user
 * comparing against `\d+` wants to see and copy: the column list with real type
 * modifiers, the constraints, the comments. It deliberately does not try to be
 * `pg_dump`, and where it cannot be faithful it emits nothing rather than
 * something plausible — see the sequence case below.
 *
 * Two rules make it safe:
 *
 *  1. Every identifier goes through `quoteIdent`. A table literally named
 *     `x"; drop table users; --` produces a `CREATE TABLE` for that name and
 *     nothing else. `quoteIdent` also refuses a NUL byte and a name over 63
 *     bytes, so a corrupt catalog row cannot yield a truncated statement.
 *  2. Server-rendered text — `pg_get_constraintdef`, `pg_get_viewdef` — is
 *     embedded verbatim. It is already correctly quoted, and rebuilding it from
 *     `conkey`/`confkey` would mean re-deriving column order, operator classes and
 *     referential actions that the server already knows how to print.
 *
 * Case convention: keywords Tabby authors are lowercase, matching every other
 * statement in `src/main/db/`. Text the server authored keeps the server's case,
 * which is why a constraint reads `constraint "t_pkey" PRIMARY KEY (id)`. That is
 * also what `pg_dump` does.
 */
import type { ColumnInfo, ConstraintMeta, SchemaNodeKind } from '../../shared/domain';
import { quoteIdent, quoteQualified } from '../../shared/ident';

export interface DdlInput {
  readonly schema: string;
  readonly name: string;
  readonly kind: SchemaNodeKind;
  readonly columns: readonly ColumnInfo[];
  readonly constraints: readonly ConstraintMeta[];
  readonly comment: string | null;
  /**
   * `pg_get_viewdef(oid, true)` for a view or materialized view; null otherwise.
   * The server's text arrives with a leading space and a **trailing semicolon**,
   * both of which `createDdl` handles.
   */
  readonly viewDefinition: string | null;
}

/**
 * Escapes the characters that would otherwise change where the literal ends.
 *
 * Order matters only in that the replacement is done in one pass: `\\` first would
 * double the backslashes introduced by the `\n` escape if they were applied
 * separately.
 */
const LITERAL_ESCAPES = new Map<string, string>([
  ['\\', '\\\\'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/**
 * A Postgres string literal for `value`.
 *
 * Uses the `E'…'` form whenever the text contains a backslash or a control
 * character. With `standard_conforming_strings = on` — the default — a backslash
 * inside `'…'` is literal, but a session can turn that setting off, and under it
 * `'\'; drop table x; --'` stops being one string. Escaping explicitly means the
 * literal denotes the same text under either setting.
 *
 * A NUL byte is dropped: no Postgres literal can carry one, and `text` values from
 * the catalog never do, so this is belt-and-braces against a corrupt row.
 */
export function quoteLiteral(value: string): string {
  // `replaceAll` rather than a regex: `no-control-regex` is there to stop a NUL
  // pattern being written by accident, and this one is deliberate but no clearer
  // for having to carry a lint suppression.
  const text = value.replaceAll('\u0000', '');
  const escaped = text.replace(
    /[\\\n\r\t]/g,
    (character) => LITERAL_ESCAPES.get(character) ?? character,
  );
  // Doubling `'` is correct in both forms and needs no escape prefix.
  const quoted = escaped.replace(/'/g, "''");
  return escaped === text ? `'${quoted}'` : `E'${quoted}'`;
}

/** `pg_get_viewdef` terminates its own output; ours terminates the statement. */
function stripTrailingSemicolon(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(';')) return trimmed;
  return trimmed.slice(0, -1).trimEnd();
}

function columnDefinition(column: ColumnInfo): string {
  const parts = [quoteIdent(column.name), column.formattedType];
  // A column we could not prove nullable was already marked nullable by
  // `toTableMeta`, so the safe direction is the one that emits nothing here.
  if (!column.nullable) parts.push('not null');
  if (column.defaultExpression !== null && column.defaultExpression !== '') {
    parts.push(`default ${column.defaultExpression}`);
  }
  return parts.join(' ');
}

function createTable(input: DdlInput, qualified: string): string {
  const members: string[] = [
    ...[...input.columns]
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(columnDefinition),
    ...input.constraints.map(
      (constraint) => `constraint ${quoteIdent(constraint.name)} ${constraint.definition}`,
    ),
  ];

  // `create table x (\n);` does not parse; Postgres wants `create table x ();`.
  if (members.length === 0) return `create table ${qualified} ();`;
  return `create table ${qualified} (\n${members.map((member) => `  ${member}`).join(',\n')}\n);`;
}

function createView(input: DdlInput, qualified: string): string | null {
  const definition = input.viewDefinition;
  if (typeof definition !== 'string') return null;
  const body = stripTrailingSemicolon(definition);
  if (body.trim() === '') return null;
  const keyword = input.kind === 'materializedView' ? 'create materialized view' : 'create view';
  // The server's text already begins with a newline-indented SELECT, so it is
  // appended as-is rather than re-indented.
  return `${keyword} ${qualified} as\n${body};`;
}

/**
 * The statements that would recreate this relation, in dependency order.
 *
 * An empty array is a real answer, not a failure: a sequence's start, increment,
 * bounds and cache are not read by Phase 6, and emitting `create sequence "s"."x";`
 * would be *valid* and *wrong* — it would silently create a different sequence.
 * Indexes and functions are likewise out of scope; their definitions are shown
 * verbatim in the pane instead of being regenerated.
 *
 * Throws `IdentifierError` if any name is unusable. Callers treat that as a bug in
 * the catalog read, not as user input.
 */
export function createDdl(input: DdlInput): readonly string[] {
  const qualified = quoteQualified(input.schema, input.name);
  const statements: string[] = [];

  if (input.kind === 'table') {
    statements.push(createTable(input, qualified));
  } else if (input.kind === 'view' || input.kind === 'materializedView') {
    const view = createView(input, qualified);
    if (view !== null) statements.push(view);
  }

  if (input.comment !== null && input.comment !== '') {
    // `comment on table` is correct for views, materialized views and sequences
    // too — that is the command Postgres uses for all of them.
    statements.push(`comment on table ${qualified} is ${quoteLiteral(input.comment)};`);
  }

  for (const column of input.columns) {
    if (column.comment === null || column.comment === '') continue;
    statements.push(
      `comment on column ${qualified}.${quoteIdent(column.name)} is ${quoteLiteral(column.comment)};`,
    );
  }

  return statements;
}
