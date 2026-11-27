import { sql } from 'drizzle-orm';
import type { AnyDb } from './db.js';
import type { ModelDefinition } from './model.js';
import { buildCreateSchema } from './validation.js';
import { insertRow } from './persistence.js';

/**
 * What a project's `seed.ts` default export receives. `insert` validates `values` against the
 * model's own create schema (the same Zod schema `POST /api/:model` uses) before writing, so a
 * typo'd field name or a wrong type fails loudly with the model and field named, instead of
 * landing a half-filled row. It bypasses the model's `create` pipeline on purpose — seeding is
 * a trusted, offline write with no request or user, same as `ratchet create-admin`.
 */
export interface SeedContext {
  db: AnyDb;
  /** Insert one row into `model` and return it (with its generated `id`). */
  insert(model: ModelDefinition, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `true` when `model` has no live (non-deleted) rows — the usual guard that keeps a seed from
   * inserting duplicates every time `ratchet dev` restarts. */
  isEmpty(model: ModelDefinition): Promise<boolean>;
}

export type SeedFn = (ctx: SeedContext) => Promise<void> | void;

/** Identity helper so a project's `seed.ts` gets `SeedContext` typed without importing it:
 * `export default defineSeed(async ({ insert, isEmpty }) => { ... })`. */
export function defineSeed(fn: SeedFn): SeedFn {
  return fn;
}

export function createSeedContext(db: AnyDb): SeedContext {
  return {
    db,
    async insert(model, values) {
      const parsed = buildCreateSchema(model).safeParse(values);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => `  - ${issue.path.join('.') || '(row)'}: ${issue.message}`)
          .join('\n');
        throw new Error(`seed: invalid row for model '${model.name}':\n${problems}`);
      }
      return insertRow(db, model, parsed.data as Record<string, unknown>);
    },
    async isEmpty(model) {
      const rows = await db.execute(
        sql`SELECT 1 AS present FROM ${sql.identifier(model.tableName)} WHERE ${sql.identifier('deleted_at')} IS NULL LIMIT 1`,
      );
      return rows.length === 0;
    },
  };
}
