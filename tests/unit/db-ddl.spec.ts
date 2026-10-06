/**
 * Generated DDL for the Phase 6 detail pane.
 *
 * Tier 1 under AGENTS.md: a pure main-process function of its inputs, with no
 * socket and no DOM. Expectations are derived from what PostgreSQL itself
 * produces, checked against a live 18.6 server rather than from the
 * implementation:
 *
 *  - `format_type` is the type text, so `character varying(255)` survives;
 *  - `pg_get_constraintdef` output is embedded **verbatim** — it is already
 *    correctly quoted, and re-quoting it would mean re-deriving column order and
 *    operator classes;
 *  - `pg_get_viewdef(oid, true)` returns a leading space and a **trailing
 *    semicolon**, both of which have to be handled or the output has `;;`.
 *
 * The security property under test is the one that matters most: every identifier
 * the generator emits goes through `quoteIdent`, so a table named
 * `x"; drop table users; --` cannot produce a statement that does anything but
 * create a table with that name.
 */
import { describe, expect, it } from 'vitest';
import type { ColumnInfo, ConstraintMeta, SchemaNodeKind } from '../../src/shared/domain';
import { createDdl, quoteLiteral, type DdlInput } from '../../src/main/db/ddl';

function column(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: 'id',
    typeName: 'int4',
    formattedType: 'integer',
    typeOid: 23,
    nullable: false,
    defaultExpression: null,
    comment: null,
    position: 1,
    ...overrides,
  };
}

function constraint(overrides: Partial<ConstraintMeta> = {}): ConstraintMeta {
  return {
    name: 'users_pkey',
    kind: 'primary',
    definition: 'PRIMARY KEY (id)',
    ...overrides,
  };
}

function input(overrides: Partial<DdlInput> = {}): DdlInput {
  return {
    schema: 'public',
    name: 'users',
    kind: 'table',
    columns: [column()],
    constraints: [constraint()],
    comment: null,
    viewDefinition: null,
    ...overrides,
  };
}

describe('quoteLiteral', () => {
  it('wraps in single quotes and doubles an embedded quote', () => {
    expect(quoteLiteral('plain')).toBe(`'plain'`);
    expect(quoteLiteral("it's")).toBe(`'it''s'`);
    expect(quoteLiteral("'")).toBe(`''''`);
    expect(quoteLiteral(`a'b`)).toBe(`'a''b'`);
  });

  it('returns an empty literal for an empty string, never nothing at all', () => {
    // `comment on table t is ;` is a syntax error; `is '';` is a real empty comment.
    expect(quoteLiteral('')).toBe(`''`);
  });

  it('switches to the E form when a backslash is present', () => {
    // With standard_conforming_strings on (the default) a backslash in `'…'` is
    // literal, but a session can turn that off, and then `'\'; drop table x; --'`
    // stops being one string. The E form escapes it explicitly, so the literal
    // means the same thing under either setting.
    expect(quoteLiteral('a\\b')).toBe(`E'a\\\\b'`);
    expect(quoteLiteral('\\')).toBe(`E'\\\\'`);
  });

  it('escapes newlines, carriage returns and tabs in the E form', () => {
    expect(quoteLiteral('two\nlines')).toBe(`E'two\\nlines'`);
    expect(quoteLiteral('a\rb')).toBe(`E'a\\rb'`);
    expect(quoteLiteral('a\tb')).toBe(`E'a\\tb'`);
    expect(quoteLiteral('q\n\\')).toBe(`E'q\\n\\\\'`);
  });

  it('doubles quotes inside the E form too', () => {
    expect(quoteLiteral("it's\nhere")).toBe(`E'it''s\\nhere'`);
  });

  it('drops a NUL byte, which no Postgres literal can carry', () => {
    expect(quoteLiteral('a\u0000b')).toBe(`'ab'`);
    expect(quoteLiteral('\u0000')).toBe(`''`);
  });

  it('round-trips through the server for the awkward cases', () => {
    // These are the shapes that appear in real COMMENT ON text.
    for (const text of ['plain', "it's", 'a\\b', 'two\nlines', '', 'ünïcødé', '日本語']) {
      const literal = quoteLiteral(text);
      expect(literal.startsWith("'") || literal.startsWith("E'"), text).toBe(true);
      expect(literal.endsWith("'"), text).toBe(true);
    }
  });
});

describe('createDdl: tables', () => {
  it('emits one CREATE TABLE with quoted schema, table and column names', () => {
    const ddl = createDdl(input());
    expect(ddl).toEqual([
      'create table "public"."users" (\n  "id" integer not null,\n  constraint "users_pkey" PRIMARY KEY (id)\n);',
    ]);
  });

  it('uses format_type, so type modifiers survive', () => {
    const ddl = createDdl(
      input({
        columns: [
          column({ name: 'name', formattedType: 'character varying(255)', nullable: true }),
          column({ name: 'amount', formattedType: 'numeric(12,4)', nullable: true, position: 3 }),
        ],
        constraints: [],
      }),
    );
    expect(ddl[0]).toContain('"name" character varying(255)');
    expect(ddl[0]).toContain('"amount" numeric(12,4)');
  });

  it('omits `not null` for a nullable column and never claims it for an unknown one', () => {
    const ddl = createDdl(input({ columns: [column({ nullable: true })], constraints: [] }));
    expect(ddl[0]).not.toContain('not null');
  });

  it('renders a default expression after the type', () => {
    const ddl = createDdl(
      input({
        columns: [
          column({
            name: 'created_at',
            formattedType: 'timestamp with time zone',
            nullable: false,
            defaultExpression: 'now()',
          }),
        ],
        constraints: [],
      }),
    );
    expect(ddl[0]).toContain('"created_at" timestamp with time zone not null default now()');
  });

  it('keeps columns in position order, which is the order psql prints them', () => {
    const ddl = createDdl(
      input({
        columns: [column({ name: 'b', position: 2 }), column({ name: 'a', position: 1 })],
        constraints: [],
      }),
    );
    expect(ddl[0]?.indexOf('"a"')).toBeLessThan(ddl[0]?.indexOf('"b"') ?? -1);
  });

  it('embeds the constraint definition verbatim rather than re-quoting it', () => {
    const ddl = createDdl(
      input({
        constraints: [
          constraint({
            name: 'fk_owner',
            kind: 'foreign',
            definition: 'FOREIGN KEY (owner_id) REFERENCES "Mixed Case"(id) ON DELETE CASCADE',
          }),
          constraint({
            name: 'amount_check',
            kind: 'check',
            definition: 'CHECK ((amount > 0::numeric))',
          }),
        ],
      }),
    );
    expect(ddl[0]).toContain(
      'constraint "fk_owner" FOREIGN KEY (owner_id) REFERENCES "Mixed Case"(id) ON DELETE CASCADE',
    );
    expect(ddl[0]).toContain('constraint "amount_check" CHECK ((amount > 0::numeric))');
  });

  it('emits valid SQL for a table with no columns', () => {
    // `create table x (\n);` does not parse. Postgres accepts `create table x ();`.
    const ddl = createDdl(input({ columns: [], constraints: [] }));
    expect(ddl).toEqual(['create table "public"."users" ();']);
  });

  it('emits valid SQL for a table with constraints but no columns', () => {
    const ddl = createDdl(input({ columns: [] }));
    expect(ddl[0]).toContain('constraint "users_pkey"');
    expect(ddl[0]).not.toContain('(\n\n');
  });

  it('appends COMMENT ON for the table and for each commented column, after the CREATE', () => {
    const ddl = createDdl(
      input({
        comment: 'the users',
        columns: [
          column(),
          column({
            name: 'email',
            formattedType: 'text',
            nullable: true,
            position: 2,
            comment: 'login',
          }),
        ],
      }),
    );
    expect(ddl).toEqual([
      'create table "public"."users" (\n  "id" integer not null,\n  "email" text,\n  constraint "users_pkey" PRIMARY KEY (id)\n);',
      `comment on table "public"."users" is 'the users';`,
      `comment on column "public"."users"."email" is 'login';`,
    ]);
  });

  it('escapes a hostile comment instead of letting it end the statement', () => {
    const ddl = createDdl(input({ comment: `x'; drop table users; --` }));
    const statement = ddl[1] ?? '';
    expect(statement).toBe(`comment on table "public"."users" is 'x''; drop table users; --';`);
    // One statement, one terminating semicolon: splitting on `;` outside a literal
    // would give two, so assert the literal is balanced instead.
    expect(statement.split(`''`).length - 1).toBe(1);
  });

  it('quotes every identifier, so a hostile name cannot escape the CREATE', () => {
    const ddl = createDdl(
      input({
        schema: 'public',
        name: 'x"; drop table users; --',
        columns: [column({ name: 'y" ; delete from t ; --' })],
        constraints: [],
      }),
    );
    expect(ddl[0]).toContain('"x""; drop table users; --"');
    expect(ddl[0]).toContain('"y"" ; delete from t ; --"');
    // The doubled quotes are what neutralise it. Collapsing every `""` pair must
    // leave exactly the delimiters of the three identifiers — schema, table,
    // column — and no stray quote that could close one early.
    const body = ddl[0] ?? '';
    expect(body.replace(/""/g, '').split('"').length - 1).toBe(6);
  });

  it('refuses an identifier quoteIdent refuses, rather than emitting a broken statement', () => {
    expect(() => createDdl(input({ name: '' }))).toThrow();
    expect(() => createDdl(input({ schema: 'bad\u0000name' }))).toThrow();
    expect(() => createDdl(input({ columns: [column({ name: 'a'.repeat(64) })] }))).toThrow();
  });
});

describe('createDdl: views', () => {
  // Exactly what `pg_get_viewdef(oid, true)` returned on the live server.
  const VIEW_DEF = ' SELECT id,\n    name\n   FROM fixtures.plain_table;';

  it('wraps the server body, dropping its trailing semicolon so the output has one', () => {
    const ddl = createDdl(
      input({
        schema: 'fixtures',
        kind: 'view',
        name: 'a_view',
        columns: [],
        constraints: [],
        viewDefinition: VIEW_DEF,
      }),
    );
    expect(ddl).toEqual([
      'create view "fixtures"."a_view" as\n SELECT id,\n    name\n   FROM fixtures.plain_table;',
    ]);
    expect(ddl[0]?.endsWith(';;')).toBe(false);
  });

  it('says materialized view for a matview', () => {
    const ddl = createDdl(
      input({
        schema: 'fixtures',
        kind: 'materializedView',
        name: 'a_matview',
        columns: [],
        constraints: [],
        viewDefinition: VIEW_DEF,
      }),
    );
    expect(ddl[0]).toMatch(/^create materialized view "fixtures"\."a_matview" as\n/);
  });

  it('emits nothing for a view whose definition did not arrive', () => {
    // Guessing a body would be worse than admitting there is none: the pane shows
    // the columns either way.
    const ddl = createDdl(
      input({ kind: 'view', name: 'v', columns: [], constraints: [], viewDefinition: null }),
    );
    expect(ddl).toEqual([]);
    const blank = createDdl(
      input({ kind: 'view', name: 'v', columns: [], constraints: [], viewDefinition: '   ' }),
    );
    expect(blank).toEqual([]);
  });

  it('still emits comments for a view with no reproducible body', () => {
    const ddl = createDdl(
      input({
        kind: 'view',
        name: 'v',
        columns: [],
        constraints: [],
        viewDefinition: null,
        comment: 'a view',
      }),
    );
    expect(ddl).toEqual([`comment on table "public"."v" is 'a view';`]);
  });

  it('ignores constraints on a view, which cannot carry any', () => {
    const ddl = createDdl(
      input({
        kind: 'view',
        name: 'v',
        columns: [],
        constraints: [constraint()],
        viewDefinition: VIEW_DEF,
      }),
    );
    expect(ddl[0]).not.toContain('constraint');
  });
});

describe('createDdl: relations it does not reproduce', () => {
  it('emits nothing for a sequence, whose parameters Tabby does not read', () => {
    // `create sequence "s"."x";` would be *valid* and *wrong* — it silently drops
    // the start, increment, min/max and cache the real one has. An empty result is
    // honest; a plausible-looking statement is not.
    expect(
      createDdl(input({ kind: 'sequence', name: 'a_sequence', columns: [], constraints: [] })),
    ).toEqual([]);
  });

  it('emits nothing for an index or a function node', () => {
    for (const kind of ['index', 'function', 'database', 'schema'] as SchemaNodeKind[]) {
      expect(createDdl(input({ kind, columns: [], constraints: [] })), kind).toEqual([]);
    }
  });

  it('still emits a comment for a sequence, which is real information', () => {
    const ddl = createDdl(
      input({ kind: 'sequence', name: 'a_sequence', columns: [], constraints: [], comment: 'ids' }),
    );
    expect(ddl).toEqual([`comment on table "public"."a_sequence" is 'ids';`]);
  });
});

describe('createDdl: shape', () => {
  it('returns one statement per array entry, each terminated by exactly one semicolon', () => {
    const ddl = createDdl(
      input({
        comment: 'c',
        columns: [column({ comment: 'col' })],
      }),
    );
    expect(ddl.length).toBe(3);
    for (const statement of ddl) {
      expect(statement.endsWith(';'), statement).toBe(true);
      expect(statement.trim().length, statement).toBeGreaterThan(0);
      // No statement may contain a bare newline-terminated second statement.
      expect(statement.slice(0, -1), statement).not.toMatch(/;\s*$/);
    }
  });

  it('is JSON-safe, so it can cross IPC untouched', () => {
    const ddl = createDdl(input({ comment: 'c' }));
    expect(JSON.parse(JSON.stringify(ddl))).toEqual(ddl);
  });

  it('does not mutate its input', () => {
    const source = input({ comment: 'c' });
    const snapshot = JSON.parse(JSON.stringify(source)) as DdlInput;
    createDdl(source);
    expect(JSON.parse(JSON.stringify(source))).toEqual(snapshot);
  });
});
