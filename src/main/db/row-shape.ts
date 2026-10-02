/**
 * Converting the driver's positional rows back into keyed records.
 *
 * Rows travel as arrays (`rowMode: 'array'`) so that two columns with the same
 * name — a self-join, or `select 1 as a, 2 as a` — cannot collide. Catalog reads
 * want the opposite: named fields. This is the one place the two meet.
 *
 * Deliberately a separate module rather than a method on the driver, so that the
 * catalog mappers can be tested without importing `pg` into their module graph.
 */

export interface PositionalResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly fields: readonly { readonly name: string }[];
}

/**
 * Zips each row onto the field names.
 *
 * Duplicate names keep the **last** column's value, which is what an object key
 * can only do; callers that care about duplicates use the positional rows
 * directly, which is why the grid's data path never comes through here.
 */
export function rowsAsRecords(result: PositionalResult): readonly Record<string, unknown>[] {
  const names = result.fields.map((field) => field.name);
  return result.rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i += 1) {
      record[names[i] ?? `column_${i}`] = row[i];
    }
    return record;
  });
}

/** One record, or null. For queries that must return at most one row. */
export function firstRecord(result: PositionalResult): Record<string, unknown> | null {
  const rows = rowsAsRecords(result);
  return rows[0] ?? null;
}

/** Reads a single scalar from a one-column, one-row result. */
export function firstScalar(result: PositionalResult): unknown {
  const row = result.rows[0];
  return row === undefined ? null : (row[0] ?? null);
}
