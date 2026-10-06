-- Fixtures for the live-Postgres integration tests (PLAN Phase 4).
--
-- Deliberately contains no credentials: connection details come from the
-- environment (see scripts/pg-check.mjs and readme.md § "Live database tests").
-- Idempotent — safe to re-run; the 10M-row load is skipped when data exists.
--
--   psql "$TABBY_TEST_PG_URL" -v ON_ERROR_STOP=1 -f scripts/pg-fixtures.sql

\set ON_ERROR_STOP on

create schema if not exists fixtures;

-- ── The large table: keyset-pagination path (has a bigint PK) ────────────────

create table if not exists fixtures.big (
  id      bigint primary key,
  bucket  integer not null,
  label   text    not null,
  payload numeric(18, 4)
);

comment on table fixtures.big is '10M rows, for the offset-jump and first-window criteria';

do $do$
begin
  if not exists (select 1 from fixtures.big limit 1) then
    insert into fixtures.big (id, bucket, label, payload)
    select g,
           (g % 97)::integer,
           'row-' || g,
           (g % 10000)::numeric / 4
    from generate_series(1, 10000000) as g;
    analyze fixtures.big;
  end if;
end
$do$;

-- ── A wide, scrollable table ─────────────────────────────────────────────────
-- `fixtures.big` is 10M rows but only four columns, so benching against it paints
-- far fewer cells than a real result and flatters the frame time. This one is the
-- shape a live grid actually has to scroll: enough rows to keep fetching, wide
-- enough to matter, every encoding the codec has (float64, bit-packed bool, UTF-8
-- blob), and NULLs sprinkled in so the null bitmap is exercised too.
--
--   TABBY_BENCH_TABLE=fixtures.wide npm run bench

create table if not exists fixtures.wide (
  id  bigint primary key,
  c01 integer,
  c02 bigint,
  c03 numeric(18, 4),
  c04 real,
  c05 double precision,
  c06 boolean,
  c07 text,
  c08 varchar(64),
  c09 char(8),
  c10 jsonb,
  c11 bytea,
  c12 date,
  c13 timestamp,
  c14 timestamptz,
  c15 uuid,
  c16 interval
);

comment on table fixtures.wide is '17 columns × 200k rows, for the live scroll benchmark';

do $do$
begin
  if not exists (select 1 from fixtures.wide limit 1) then
    insert into fixtures.wide
    select g,
           case when g % 11 = 0 then null else (g % 97)::integer end,
           (g * 7)::bigint,
           (g % 10000)::numeric / 4,
           (g % 1000)::real / 3,
           (g % 1000)::double precision / 7,
           (g % 2 = 0),
           'label-' || g || '-' || md5(g::text),
           left(md5(g::text), 24),
           left(md5(g::text), 8),
           jsonb_build_object('id', g, 'tag', left(md5(g::text), 8)),
           decode(left(md5(g::text), 16), 'hex'),
           date '2020-01-01' + (g % 2000),
           timestamp '2020-01-01 00:00:00' + (g % 86400) * interval '1 second',
           timestamptz '2020-01-01 00:00:00+00' + (g % 86400) * interval '1 second',
           ('00000000-0000-0000-0000-' || left(md5(g::text), 12))::uuid,
           (g % 3600) * interval '1 second'
    from generate_series(1, 200000) as g;
    analyze fixtures.wide;
  end if;
end
$do$;

-- ── Row identity: the four shapes the resolver must distinguish ───────────────

-- No PK, no unique index at all → not addressable, resolve() must return null.
create table if not exists fixtures.no_identity (
  a integer,
  b text
);

-- Composite PK → identity is both columns, in index order.
create table if not exists fixtures.composite_pk (
  tenant_id integer not null,
  seq       integer not null,
  note      text,
  primary key (tenant_id, seq)
);

-- No PK, but a unique NOT NULL index → usable as a fallback identity.
create table if not exists fixtures.unique_index (
  id   integer not null,
  code text    not null
);
create unique index if not exists unique_index_code_uq on fixtures.unique_index (code);

-- A unique index that is NULLABLE → must NOT be used, since NULL != NULL and an
-- UPDATE keyed on it could silently match zero or many rows.
create table if not exists fixtures.unique_nullable (
  id    integer,
  email text
);
create unique index if not exists unique_nullable_email_uq on fixtures.unique_nullable (email);

-- ── Type coverage for the columnar codec ─────────────────────────────────────

create table if not exists fixtures.type_matrix (
  id           serial primary key,
  c_int2       smallint,
  c_int4       integer,
  c_int8       bigint,
  c_numeric    numeric(30, 10),
  c_float4     real,
  c_float8     double precision,
  c_bool       boolean,
  c_text       text,
  c_varchar    varchar(64),
  c_char       char(8),
  c_json       json,
  c_jsonb      jsonb,
  c_bytea      bytea,
  c_date       date,
  c_timestamp  timestamp,
  c_timestamptz timestamptz,
  c_uuid       uuid,
  c_interval   interval,
  c_array      integer[]
);

-- Idempotent by construction: these rows carry no natural key, so a second run
-- would duplicate them. Recreating from scratch keeps the count at exactly four.
truncate table fixtures.type_matrix restart identity;

insert into fixtures.type_matrix (
  c_int2, c_int4, c_int8, c_numeric, c_float4, c_float8, c_bool,
  c_text, c_varchar, c_char, c_json, c_jsonb, c_bytea,
  c_date, c_timestamp, c_timestamptz, c_uuid, c_interval, c_array
) values
  (1, 2, 9007199254740993, 12345678901234567890.1234567890, 1.5, 2.5, true,
   'plain', 'vc', 'padded', '{"k":1}', '{"k":2}', '\x0001ff',
   '2026-10-01', '2026-10-01 12:34:56', '2026-10-01T12:34:56+07:00',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '1 day 02:03:04', '{1,2,3}'),
  -- NULLs in every column: the null bitmap has to survive a full round-trip.
  (null, null, null, null, null, null, null,
   null, null, null, null, null, null,
   null, null, null, null, null, null),
  -- Boundary values: int8 beyond Number.MAX_SAFE_INTEGER, and the exact limit.
  (-32768, -2147483648, -9223372036854775808, -0.0000000001, -1.5, -2.5, false,
   '', '', '', '[]', '[]', '\x',
   '0001-01-01', '0001-01-01 00:00:00', '0001-01-01T00:00:00Z',
   '00000000-0000-0000-0000-000000000000', '00:00:00', '{}'),
  (32767, 2147483647, 9007199254740991, 0, 0, 0, true,
   E'tab\there', E'quote"dq', 'x', '"escaped"', '{"nested":{"deep":[1,2]}}', '\xdeadbeef',
   '9999-12-31', '9999-12-31 23:59:59.999999', '9999-12-31T23:59:59.999999-11:30',
   'ffffffff-ffff-ffff-ffff-ffffffffffff', '-1 day', '{-1,0,1}');

comment on column fixtures.type_matrix.c_int8 is 'kept as a string: int8 exceeds 2^53';

-- ── Identifier safety ────────────────────────────────────────────────────────
-- These exist so quoteIdent is tested against real Postgres, not just a regex.

create table if not exists fixtures."Mixed Case" (id integer primary key, v text);
create table if not exists fixtures."has space" (id integer primary key, v text);
create table if not exists fixtures."with""dquote" (id integer primary key, v text);
create table if not exists fixtures."unicode_ünïcødé" (id integer primary key, v text);
create table if not exists fixtures.reserved_word ("select" integer primary key, "from" text);

insert into fixtures."Mixed Case" values (1, 'mixed') on conflict do nothing;
insert into fixtures."has space" values (1, 'space') on conflict do nothing;
insert into fixtures."with""dquote" values (1, 'dquote') on conflict do nothing;
insert into fixtures."unicode_ünïcødé" values (1, 'unicode') on conflict do nothing;
insert into fixtures.reserved_word values (1, 'reserved') on conflict do nothing;

-- ── Schema-tree fixtures ─────────────────────────────────────────────────────

create table if not exists fixtures.plain_table (id integer primary key, name text);
comment on table fixtures.plain_table is 'a commented table';

create or replace view fixtures.a_view as select id, name from fixtures.plain_table;
create materialized view if not exists fixtures.a_matview as select 1::integer as one;
create sequence if not exists fixtures.a_sequence;

-- A second schema, so schemaChildren has more than one node to return.
create schema if not exists fixtures_secondary;
create table if not exists fixtures_secondary.other (id integer primary key);

-- ── Read-only enforcement ────────────────────────────────────────────────────
-- The integration test INSERTs into this table and asserts the server refuses it
-- with SQLSTATE 25006. It exists so that a broken read-only guarantee writes to a
-- throwaway table rather than to one holding fixture data.

create table if not exists fixtures.read_only_probe (
  id   serial primary key,
  note text
);

-- ── Cancellation ─────────────────────────────────────────────────────────────
-- Deliberately no fixture object here.
--
-- The cancellation test needs a query that *streams*: one whose first row arrives
-- in milliseconds while the rest are still being produced, so there is something
-- in flight to cancel. A SQL function does not do that — returning a set lets
-- Postgres materialise the whole body before LIMIT or FETCH applies, so the first
-- FETCH waits for all 1000 sleeps. A `pg_sleep` in a LATERAL join is worse: it is
-- evaluated once rather than per row, and the "slow" query returns instantly.
-- Both forms were tried; neither can support the test.
--
-- The form that works, used verbatim by the integration test:
--
--   select g as n, pg_sleep(0.05) as waited from generate_series(1, 1000) as g
--
-- `pg_sleep` in the target list is evaluated per output row, and a cursor over it
-- returns its first row in ~50ms while the remaining rows take ~50s.

drop function if exists fixtures.slow(double precision);

-- ── Phase 6: the detail pane's comparison fixture ────────────────────────────
-- Everything `\d+` shows for one table, in one place: type modifiers that only
-- `format_type` renders, NOT NULL, defaults, table and column comments, a primary
-- key, a table unique constraint, a check, a foreign key, and the three index
-- shapes that matter — plain, expression, and partial.
--
-- The partial unique index is the interesting one. `INDEXES_SQL` must exclude it
-- (`indpred is null`), because "unique among rows matching a predicate" cannot
-- identify a row; `INDEX_DEFS_SQL` must include it, because hiding it would hide
-- the reason a duplicate insert was rejected. One object, two correct answers.

create table if not exists fixtures.detail_sample (
  id         bigint primary key,
  tenant_id  integer not null default 1,
  code       varchar(64) not null,
  label      character varying(255),
  amount     numeric(12, 4) default 0,
  created_at timestamptz not null default now(),
  note       text,
  constraint detail_sample_code_uq unique (code),
  constraint detail_sample_amount_chk check (amount >= 0),
  constraint detail_sample_tenant_fk foreign key (tenant_id)
    references fixtures.plain_table (id)
);

create index if not exists detail_sample_label_idx on fixtures.detail_sample (label);
create index if not exists detail_sample_lower_code_idx on fixtures.detail_sample (lower(code));
create unique index if not exists detail_sample_partial_uq
  on fixtures.detail_sample (tenant_id)
  where note is not null;

comment on table fixtures.detail_sample is 'the detail-pane comparison fixture';
comment on column fixtures.detail_sample.id is 'surrogate key';
comment on column fixtures.detail_sample.amount is 'non-negative, enforced by a check';
comment on column fixtures.detail_sample.note is E'nullable on purpose\nso the partial index has rows to exclude';

-- ── Phase 6: the virtualised tree's scale fixture ────────────────────────────
-- 2,000 relations in one schema. The exit criterion is that the tree renders and
-- scrolls this smoothly, which cannot be measured against a schema with five
-- tables: everything would fit in the viewport and the windowing would never run.
--
-- Created inside a DO block with `if not exists`, so a re-run is a no-op rather
-- than an error, and the count guard means a warm database skips the loop.

create schema if not exists fixtures_many;

do $do$
declare
  existing integer;
begin
  select count(*) into existing
  from pg_catalog.pg_class cls
  join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
  where nsp.nspname = 'fixtures_many' and cls.relkind = 'r';

  if existing < 2000 then
    for i in 0..1999 loop
      execute format(
        'create table if not exists fixtures_many.t%s (id integer primary key, label text)',
        lpad(i::text, 4, '0')
      );
    end loop;
  end if;
end
$do$;

select pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size('fixtures.big')) as big_size,
       (select count(*) from fixtures.type_matrix) as type_matrix_rows,
       (select count(*) from pg_catalog.pg_class cls
          join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
         where nsp.nspname = 'fixtures_many' and cls.relkind = 'r') as many_tables;

