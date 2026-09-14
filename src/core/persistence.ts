import { sql, type Name, type SQL } from 'drizzle-orm';
import type { AnyDb } from './db.js';
import type { FieldDefinition } from './field.js';
import type { ModelDefinition } from './model.js';
import { generateId } from './id.js';
import { rowToCamelCase, toSnakeCase } from './naming.js';
import { normalizeJsonFields, normalizeTimestamps } from './serialize.js';

type Chunk = SQL | Name;

function tableIdent(model: ModelDefinition): Name {
  return sql.identifier(model.tableName);
}

/**
 * Drizzle's typed `.insert()/.update()` builders serialize values (Date -> ISO string,
 * objects -> JSON) via each column's encoder; going through raw `sql` templates directly
 * (necessary here since these primitives are generic across every model's table) bypasses
 * that, so it has to be done by hand.
 */
function toDriverValue(fieldDef: FieldDefinition | undefined, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  // `file` is jsonb too (`StoredFile`, see core/storage.ts) — same encoding need as `json`.
  if ((fieldDef?.kind === 'json' || fieldDef?.kind === 'file') && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

export async function fetchRow(
  db: AnyDb,
  model: ModelDefinition,
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const deletedClause = opts.includeDeleted ? sql`` : sql` AND ${sql.identifier('deleted_at')} IS NULL`;
  const rows = await db.execute(
    sql`SELECT * FROM ${tableIdent(model)} WHERE ${sql.identifier('id')} = ${id}${deletedClause} LIMIT 1`,
  );
  return rows[0] ? normalizeTimestamps(model, normalizeJsonFields(model, rowToCamelCase(rows[0]))) : null;
}

/** Every row in `model` whose `fieldKey` column equals `value` (soft-deleted rows excluded) —
 * e.g. every `WorkspaceView` belonging to one `workspaceId`. `fieldKey` must be a real field on
 * `model`; callers pass a fixed, code-authored key (never raw user input) since there's no
 * `isKnownColumn`-style check here the way `router/query.ts` has for request-driven filters. */
export async function listRowsByField(
  db: AnyDb,
  model: ModelDefinition,
  fieldKey: string,
  value: unknown,
): Promise<Record<string, unknown>[]> {
  const rows = await db.execute(
    sql`SELECT * FROM ${tableIdent(model)} WHERE ${sql.identifier(toSnakeCase(fieldKey))} = ${value} AND ${sql.identifier('deleted_at')} IS NULL`,
  );
  return rows.map((row) => normalizeTimestamps(model, normalizeJsonFields(model, rowToCamelCase(row))));
}

/** The ids of `targetModelName`'s rows whose `inverseCol` (e.g. `article_id`) equals `parentId`
 * (soft-deleted rows excluded) — i.e. the current children of a one-to-many parent. Uses the raw
 * table name (which equals the model name) directly so callers don't need the target's
 * `ModelDefinition` in hand; used by `core/pipeline.ts`'s `syncReferenceToManyFields`. */
export async function listChildIds(
  db: AnyDb,
  targetModelName: string,
  inverseCol: string,
  parentId: string,
): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT id FROM ${sql.identifier(targetModelName)} WHERE ${sql.identifier(toSnakeCase(inverseCol))} = ${parentId} AND ${sql.identifier('deleted_at')} IS NULL`,
  );
  return rows.map((row) => String(row.id));
}

/** Sets/clears `targetModelName`'s `inverseCol` FK (e.g. `article_id`) on one child row. Passing
 * `null` detaches the child from its parent; any non-null `parentId` reassigns it (a child belongs to
 * exactly one parent, so this naturally enforces the one-to-many invariant). Only touches non-deleted
 * rows. Raw-SQL on purpose: the inverse column isn't a field on *this* model, so `updateRow` wouldn't
 * write it — see `core/reference-to-many.ts`. */
export async function setInverseForeignKey(
  db: AnyDb,
  targetModelName: string,
  inverseCol: string,
  childId: string,
  parentId: string | null,
): Promise<void> {
  await db.run(
    sql`UPDATE ${sql.identifier(targetModelName)} SET ${sql.identifier(toSnakeCase(inverseCol))} = ${parentId} WHERE ${sql.identifier('id')} = ${childId} AND ${sql.identifier('deleted_at')} IS NULL`,
  );
}

export async function insertRow(
  db: AnyDb,
  model: ModelDefinition,
  input: Record<string, unknown>,
  createdById?: string | null,
): Promise<Record<string, unknown>> {
  const id = generateId();
  const now = new Date();

  const columns: Chunk[] = [sql.identifier('id'), sql.identifier('created_at'), sql.identifier('updated_at')];
  const values: Chunk[] = [sql`${id}`, sql`${now.toISOString()}`, sql`${now.toISOString()}`];
  if (createdById != null) {
    columns.push(sql.identifier('created_by_id'));
    values.push(sql`${createdById}`);
  }

  for (const [key, fieldDef] of Object.entries(model.fields)) {
    // manyToMany has no backing column — its value is diffed into junction rows separately,
    // after this insert, by `persistWrite` (core/pipeline.ts), once the new row's id is known.
    // referenceToMany is the same: its value is synced onto the *target* model's inverse FK column
    // by `syncReferenceToManyFields`, also after this insert — there's no column on this model.
    if (fieldDef.kind === 'manyToMany' || fieldDef.kind === 'referenceToMany') continue;
    const value = key in input ? input[key] : fieldDef.default;
    if (value === undefined) continue;
    columns.push(sql.identifier(toSnakeCase(key)));
    values.push(sql`${toDriverValue(fieldDef, value)}`);
  }

  const rows = await db.execute(
    sql`INSERT INTO ${tableIdent(model)} (${sql.join(columns, sql`, `)}) VALUES (${sql.join(values, sql`, `)}) RETURNING *`,
  );
  const row = rows[0];
  if (!row) throw new Error(`persist: insert into '${model.tableName}' returned no row`);
  return normalizeTimestamps(model, normalizeJsonFields(model, rowToCamelCase(row)));
}

export async function updateRow(
  db: AnyDb,
  model: ModelDefinition,
  id: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const now = new Date();
  const setParts: SQL[] = [sql`${sql.identifier('updated_at')} = ${now.toISOString()}`];

  for (const [key, fieldDef] of Object.entries(model.fields)) {
    if (fieldDef.kind === 'manyToMany' || fieldDef.kind === 'referenceToMany') continue; // see insertRow's matching skip
    if (!(key in input)) continue;
    setParts.push(sql`${sql.identifier(toSnakeCase(key))} = ${toDriverValue(fieldDef, input[key])}`);
  }

  const rows = await db.execute(
    sql`UPDATE ${tableIdent(model)} SET ${sql.join(setParts, sql`, `)} WHERE ${sql.identifier('id')} = ${id} AND ${sql.identifier('deleted_at')} IS NULL RETURNING *`,
  );
  return rows[0] ? normalizeTimestamps(model, normalizeJsonFields(model, rowToCamelCase(rows[0]))) : null;
}

export async function softRemoveRow(
  db: AnyDb,
  model: ModelDefinition,
  id: string,
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const rows = await db.execute(
    sql`UPDATE ${tableIdent(model)} SET ${sql.identifier('deleted_at')} = ${now}, ${sql.identifier('updated_at')} = ${now} WHERE ${sql.identifier('id')} = ${id} AND ${sql.identifier('deleted_at')} IS NULL RETURNING *`,
  );
  return rows[0] ? normalizeTimestamps(model, normalizeJsonFields(model, rowToCamelCase(rows[0]))) : null;
}

export async function hardRemoveRow(db: AnyDb, model: ModelDefinition, id: string): Promise<void> {
  await db.run(sql`DELETE FROM ${tableIdent(model)} WHERE ${sql.identifier('id')} = ${id}`);
}
