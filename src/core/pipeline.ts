import type { AnyDb } from './db.js';
import type { ModelDefinition } from './model.js';
import { buildCreateSchema, buildUpdateSchema } from './validation.js';
import { fetchRow, hardRemoveRow, insertRow, listChildIds, listRowsByField, setInverseForeignKey, softRemoveRow, updateRow } from './persistence.js';
import {
  allManyToManyRelationsInvolving,
  buildJunctionModel,
  junctionColumnFor,
  junctionColumnsOf,
  manyToManyFieldsOf,
  type ManyToManyRelation,
} from './many-to-many.js';
import {
  inverseColumnName,
  referenceToManyFieldsOf,
  type ReferenceToManyRelation,
} from './reference-to-many.js';
import { treeFieldOf, wouldCreateTreeCycle } from './tree.js';

// A custom operation (core/model.ts's `CustomOperationDefinition`) runs under its own name here —
// `validate`/`persist` below only ever special-case `'create'` (everything else is treated as an
// update-shaped write), and `pipe()`'s auto-prefetch only special-cases `'create'` too, so a custom
// operation name naturally gets the same "fetch the existing row first" behavior as `update`. The
// three literals stay for editor autocomplete on the common cases.
export type Operation = 'create' | 'update' | 'remove' | (string & {});


export interface OperationContext {
  operation: Operation;
  /** id of the record being acted on; required for update/remove, absent for create */
  id?: string;
  /** the pending write payload — mutated by business logic before `persist` runs */
  input: Record<string, unknown>;
  /** the record as it existed before this operation; null on create, auto-prefetched otherwise */
  doc: Record<string, unknown> | null;
  model: ModelDefinition;
  db: AnyDb;
  request?: Request;
  /** the authenticated user, resolved by `requireAuth` (ratchet/auth) and read by
   * `requirePermission`/business logic — absent until an auth pipeline step sets it. */
  user?: Record<string, unknown> | null;
  /** name -> ModelDefinition lookup for the whole app, set by the router that builds this ctx
   * (src/router/create-router.ts). Read by `requireValidPermissions`/`validatePermissionTarget`
   * (ratchet/auth) to check a permission target's `resource`/`action` against what actually
   * exists. Optional because call sites outside the generic `/api/:model` router (e.g.
   * `/api/auth/register`) don't need it. */
  registry?: Record<string, ModelDefinition>;
}

export interface PipelineErrorOptions {
  code: string;
  status: number;
  message?: string;
  fields?: Record<string, string>;
}

export class PipelineError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;

  constructor(opts: PipelineErrorOptions) {
    super(opts.message ?? opts.code);
    this.name = 'PipelineError';
    this.code = opts.code;
    this.status = opts.status;
    this.fields = opts.fields;
  }
}

export type PipelineFn = (ctx: OperationContext) => OperationContext | Promise<OperationContext>;

// Q21b: `persist` / `persist.remove` / `persist.hardRemove` are the one place pipe() needs
// positional awareness of a link's identity — they mark the boundary between the transactional
// (pre-write) and post-commit (post-write) portions of a pipeline. Everything else in `pipe()`
// treats links as opaque functions.
const writeBoundaries = new WeakSet<PipelineFn>();
function markWriteBoundary<T extends PipelineFn>(fn: T): T {
  writeBoundaries.add(fn);
  return fn;
}

export function pipe(...fns: PipelineFn[]): PipelineFn {
  const boundaryIndex = fns.findIndex((fn) => writeBoundaries.has(fn));
  const preBoundary = boundaryIndex === -1 ? fns : fns.slice(0, boundaryIndex + 1);
  const postBoundary = boundaryIndex === -1 ? [] : fns.slice(boundaryIndex + 1);

  return async function runPipeline(initialCtx: OperationContext): Promise<OperationContext> {
    const topDb = initialCtx.db;

    const afterCommit = await topDb.transaction(async (tx) => {
      let current: OperationContext = { ...initialCtx, db: tx as AnyDb };

      // Q3/Q22: auto-prefetch is the transaction's first statement, so every read downstream
      // (business logic and the eventual write) sees one consistent view of the row.
      if (current.operation !== 'create' && current.doc === null) {
        if (!current.id) {
          throw new PipelineError({ code: 'NOT_FOUND', status: 404, message: 'no id provided for update/remove' });
        }
        const doc = await fetchRow(current.db, current.model, current.id);
        if (!doc) {
          throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
        }
        current = { ...current, doc };
      }

      for (const fn of preBoundary) {
        current = await fn(current);
      }
      return current;
    });

    // Q11/Q21b: steps after the write boundary run post-commit, non-transactionally — a
    // failure here does not roll back the already-committed write.
    let current: OperationContext = { ...afterCommit, db: topDb };
    for (const fn of postBoundary) {
      current = await fn(current);
    }
    return current;
  };
}

/** Pairs with `ApiModelOptions.ownerField` (core/model.ts): on `create`, overwrites
 * `ctx.input[ownerField]` with the requesting user's id (ignoring any client-supplied value) so a
 * row is always created under the real requester; on `update`/`remove`, checks the already-
 * prefetched `ctx.doc[ownerField]` against that same id and 404s on mismatch — same "don't reveal
 * existence" behavior as `automation/pipeline.ts`'s `assertOwnsChat`. Must run after `requireAuth`
 * (needs `ctx.user`) and, for `create`, before `validate` (so the schema sees the real owner id). */
export function requireOwnsRow(ownerField: string): PipelineFn {
  return async (ctx) => {
    if (ctx.user === undefined) {
      throw new PipelineError({ code: 'INTERNAL', status: 500, message: 'requireOwnsRow run before requireAuth' });
    }
    const userId = (ctx.user as { id?: string } | null)?.id;
    if (ctx.operation === 'create') {
      return { ...ctx, input: { ...ctx.input, [ownerField]: userId } };
    }
    if (ctx.doc?.[ownerField] !== userId) {
      throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    }
    return ctx;
  };
}

export const validate: PipelineFn = async (ctx) => {
  const schema = ctx.operation === 'create' ? buildCreateSchema(ctx.model) : buildUpdateSchema(ctx.model);
  const result = schema.safeParse(ctx.input);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      if (!(key in fields)) fields[key] = issue.message;
    }
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
  }
  return { ...ctx, input: result.data as Record<string, unknown> };
};

interface PersistFn {
  (ctx: OperationContext): Promise<OperationContext>;
  remove: PipelineFn;
  hardRemove: PipelineFn;
}

/** Diffs one manyToMany field's desired target-id list against its current junction rows and
 * writes exactly the difference — inserting rows for newly-added ids, soft-removing rows for
 * dropped ones (soft, not hard: matches every other delete in this framework, and lets the
 * relation's `(source, target)` partial-unique index — see schema-gen.ts — allow a re-attach
 * without colliding with the old, now-deleted row). Runs on the same `db` handle `persistWrite`/
 * `persistRemove` were given, which is the enclosing `pipe()`'s transaction (`tx`) while this is
 * called from inside them — see `pipe()` in this file — so a partial diff can never commit. */
async function syncManyToMany(
  db: AnyDb,
  relation: ManyToManyRelation,
  sourceId: string,
  desiredTargetIds: readonly string[],
  createdById: string | null,
): Promise<void> {
  const junctionModel = buildJunctionModel(relation);
  const cols = junctionColumnsOf(relation);
  const current = await listRowsByField(db, junctionModel, cols.sourceColumn, sourceId);
  const currentByTargetId = new Map(current.map((row) => [row[cols.targetColumn] as string, row]));
  const desired = new Set(desiredTargetIds);

  for (const targetId of desiredTargetIds) {
    if (!currentByTargetId.has(targetId)) {
      await insertRow(db, junctionModel, { [cols.sourceColumn]: sourceId, [cols.targetColumn]: targetId }, createdById);
    }
  }
  for (const [targetId, row] of currentByTargetId) {
    if (!desired.has(targetId)) {
      await softRemoveRow(db, junctionModel, row.id as string);
    }
  }
}

/** Applies `syncManyToMany` to every manyToMany field this model declares that's actually present
 * in `input` — a field omitted from the create/update body is left untouched entirely (not
 * cleared), matching how every other optional field already behaves on a PATCH-shaped update. */
async function syncManyToManyFields(
  db: AnyDb,
  model: ModelDefinition,
  input: Record<string, unknown>,
  sourceId: string,
  createdById: string | null,
): Promise<void> {
  for (const relation of manyToManyFieldsOf(model)) {
    if (!(relation.fieldKey in input)) continue;
    await syncManyToMany(db, relation, sourceId, input[relation.fieldKey] as string[], createdById);
  }
}

/** Diffs one `referenceToMany` field's desired child-id list against the target rows' current
 * inverse-FK values and writes exactly the difference — adding each newly-listed child (setting its
 * inverse FK to `sourceId`, which reassigns it from any prior parent since a child has exactly one),
 * and clearing the inverse FK to `null` on each current child that's no longer listed. Runs on the
 * same `db` handle `persistWrite`/`persistRemove` were given (the enclosing `pipe()` transaction's
 * `tx`), so a partial diff can never commit. */
async function syncReferenceToMany(
  db: AnyDb,
  relation: ReferenceToManyRelation,
  sourceId: string,
  desiredChildIds: readonly string[],
): Promise<void> {
  const targetModelName = relation.fieldDef.targetModel;
  const inverseCol = inverseColumnName(relation);
  const current = await listChildIds(db, targetModelName, inverseCol, sourceId);
  const currentSet = new Set(current);
  const desired = new Set(desiredChildIds);

  for (const childId of desiredChildIds) {
    if (!currentSet.has(childId)) {
      await setInverseForeignKey(db, targetModelName, inverseCol, childId, sourceId);
    }
  }
  for (const childId of current) {
    if (!desired.has(childId)) {
      await setInverseForeignKey(db, targetModelName, inverseCol, childId, null);
    }
  }
}

/** Applies `syncReferenceToMany` to every referenceToMany field this model declares that's actually
 * present in `input` — a field omitted from the create/update body is left untouched (as with
 * manyToMany), matching every other optional field on a PATCH-shaped update. */
async function syncReferenceToManyFields(
  db: AnyDb,
  model: ModelDefinition,
  input: Record<string, unknown>,
  sourceId: string,
): Promise<void> {
  for (const relation of referenceToManyFieldsOf(model)) {
    if (!(relation.fieldKey in input)) continue;
    await syncReferenceToMany(db, relation, sourceId, (input[relation.fieldKey] as string[]) ?? []);
  }
}

/** Detaches every child of a removed parent by nulling the inverse FK (`onDelete: 'restrict'` on the
 * column would otherwise refuse a hard delete that left orphans). Called from both `persist.remove`
 * (soft) and `persist.hardRemove` so a deleted parent never keeps a dangling FK — a soft-removed
 * parent's children become freely reassignable rather than stranded. */
async function detachReferenceToManyChildren(db: AnyDb, model: ModelDefinition, id: string): Promise<void> {
  for (const relation of referenceToManyFieldsOf(model)) {
    const childIds = await listChildIds(db, relation.fieldDef.targetModel, inverseColumnName(relation), id);
    for (const childId of childIds) {
      await setInverseForeignKey(db, relation.fieldDef.targetModel, inverseColumnName(relation), childId, null);
    }
  }
}

/** Guards a `field.tree()` write against a cycle — re-parenting a node under itself or one of its
 * own descendants. A no-op for a model with no tree field, or an update that doesn't touch the
 * tree field's key at all (the common case — most updates don't reparent), and for `null` (root is
 * never anyone's descendant, so it can never cycle). `create` never needs this: a fresh row's id
 * doesn't exist yet, so it can't already be an ancestor of anything. */
async function assertNoTreeCycle(db: AnyDb, model: ModelDefinition, id: string, input: Record<string, unknown>): Promise<void> {
  const tree = treeFieldOf(model);
  if (!tree || !(tree.key in input)) return;
  const newParentId = input[tree.key] as string | null;
  if (newParentId === null) return;
  if (await wouldCreateTreeCycle(db, model, tree.key, id, newParentId)) {
    throw new PipelineError({
      code: 'TREE_CYCLE',
      status: 400,
      fields: { [tree.key]: 'cannot set a node as a descendant of itself' },
    });
  }
}

const persistWrite: PipelineFn = async (ctx) => {
  const createdById = (ctx.user as { id?: string } | null | undefined)?.id ?? null;
  if (ctx.operation === 'create') {
    const doc = await insertRow(ctx.db, ctx.model, ctx.input, createdById);
    await syncManyToManyFields(ctx.db, ctx.model, ctx.input, doc.id as string, createdById);
    await syncReferenceToManyFields(ctx.db, ctx.model, ctx.input, doc.id as string);
    return { ...ctx, doc };
  }
  if (!ctx.id) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  await assertNoTreeCycle(ctx.db, ctx.model, ctx.id, ctx.input);
  const doc = await updateRow(ctx.db, ctx.model, ctx.id, ctx.input);
  if (!doc) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  await syncManyToManyFields(ctx.db, ctx.model, ctx.input, ctx.id, createdById);
  await syncReferenceToManyFields(ctx.db, ctx.model, ctx.input, ctx.id);
  return { ...ctx, doc };
};

/** Cascades a soft-remove into every manyToMany relation touching this model, source or target
 * side alike (Q4, round 2 of the design discussion) — e.g. soft-removing a `Tag` soft-removes every
 * `posts_tags` row that pointed at it, even though `Tag` never itself declared the `tags` relation.
 * Needs `ctx.registry` (only set by the generic `/api/:model` router, see `OperationContext`'s own
 * doc comment) to find relations declared on *other* models; silently skips cascade when it's
 * absent rather than erroring, since a hand-rolled call site with no registry has no way to know
 * about relations it isn't a party to either. */
const persistRemove: PipelineFn = async (ctx) => {
  if (!ctx.id) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  const doc = await softRemoveRow(ctx.db, ctx.model, ctx.id);
  if (!doc) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  if (ctx.registry) {
    for (const relation of allManyToManyRelationsInvolving(ctx.registry, ctx.model.name)) {
      const junctionModel = buildJunctionModel(relation);
      const col = junctionColumnFor(relation, ctx.model.name);
      const rows = await listRowsByField(ctx.db, junctionModel, col, ctx.id);
      for (const row of rows) {
        await softRemoveRow(ctx.db, junctionModel, row.id as string);
      }
    }
  }
  // a soft-deleted parent should not keep owning children — detach them so they're reassignable.
  await detachReferenceToManyChildren(ctx.db, ctx.model, ctx.id);
  return { ...ctx, doc };
};

const persistHardRemove: PipelineFn = async (ctx) => {
  if (!ctx.id) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  // clear the inverse FK first so the column's `onDelete: 'restrict'` doesn't refuse the delete.
  await detachReferenceToManyChildren(ctx.db, ctx.model, ctx.id);
  await hardRemoveRow(ctx.db, ctx.model, ctx.id);
  return { ...ctx, doc: null };
};

markWriteBoundary(persistWrite);
markWriteBoundary(persistRemove);
markWriteBoundary(persistHardRemove);

export const persist = persistWrite as PersistFn;
persist.remove = persistRemove;
persist.hardRemove = persistHardRemove;
