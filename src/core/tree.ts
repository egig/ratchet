import { sql } from 'drizzle-orm';
import type { AnyDb } from './db.js';
import type { TreeFieldDefinition } from './field.js';
import type { ModelDefinition } from './model.js';
import { toSnakeCase } from './naming.js';


export interface TreeField {
  key: string;
  fieldDef: TreeFieldDefinition;
}

/** The model's single `field.tree()` field (`defineModel()` rejects declaring a second one), if
 * it declared one at all — `undefined` for a model with no hierarchy. Mirrors
 * `core/many-to-many.ts`'s `manyToManyFieldsOf`, just narrowed to at most one match. */
export function treeFieldOf(model: ModelDefinition): TreeField | undefined {
  const entry = Object.entries(model.fields).find((e): e is [string, TreeFieldDefinition] => e[1].kind === 'tree');
  return entry ? { key: entry[0], fieldDef: entry[1] } : undefined;
}

/**
 * Walks `newParentId`'s own ancestor chain (following `model`'s tree field, one row at a time)
 * looking for `id` — finding it means pointing `id`'s parent at `newParentId` would make `id` its
 * own ancestor, which a tree has no room for (every node needs exactly one unambiguous path to the
 * root). `newParentId === id` (an immediate self-parent) is caught on the walk's first step, same
 * as any deeper cycle.
 *
 * `maxDepth` (default far past any real chart-of-accounts/category depth) is a defensive cap, not
 * cycle detection on the walk itself: the tree this reads is already guaranteed acyclic by this
 * same check running on every prior write, so hitting it would mean that guarantee was broken by
 * something outside this code path (e.g. a row inserted directly, bypassing the pipeline).
 */
export async function wouldCreateTreeCycle(
  db: AnyDb,
  model: ModelDefinition,
  parentField: string,
  id: string,
  newParentId: string,
  maxDepth = 1000,
): Promise<boolean> {
  const col = sql.identifier(toSnakeCase(parentField));
  const table = sql.identifier(model.tableName);
  let cursor: string | null = newParentId;

  for (let depth = 0; depth < maxDepth && cursor !== null; depth++) {
    if (cursor === id) return true;
    const rows = await db.execute(sql`SELECT ${col} AS parent_id FROM ${table} WHERE id = ${cursor} LIMIT 1`);
    cursor = (rows[0]?.parent_id as string | null | undefined) ?? null;
  }
  return false;
}
