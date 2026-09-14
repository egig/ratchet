import { sql, type Name, type SQL } from 'drizzle-orm';
import type { AnyDb, Dialect } from '../core/db.js';
import type { ReferenceFieldDefinition, TreeFieldDefinition } from '../core/field.js';
import type { ModelDefinition } from '../core/model.js';
import {
  buildJunctionModel,
  findRelationsTargeting,
  junctionColumnsOf,
  type ManyToManyRelation,
} from '../core/many-to-many.js';
import { inverseColumnName, referenceToManyFieldsOf, type ReferenceToManyRelation } from '../core/reference-to-many.js';
import { PipelineError } from '../core/pipeline.js';
import { rowToCamelCase, toSnakeCase } from '../core/naming.js';
import { deriveFileFields, normalizeJsonFields, normalizeTimestamps, redactSensitiveFields } from '../core/serialize.js';
import { allColumnKeys } from './columns.js';
import { encodeCursor, type FilterClause, type FilterNode, type ParsedListQuery } from './query.js';


function tableIdent(model: ModelDefinition): Name {
  return sql.identifier(model.tableName);
}

interface IncludePlan {
  relationName: string;
  fkField: string;
  targetModel: ModelDefinition;
}

/** manyToMany include names (forward or reverse — see `router/query.ts`'s `parseInclude`) are
 * handled entirely separately (`resolveManyToManyIncludes`/`attachManyToManyIncludes` below), so
 * this only ever needs to build plans for the `reference`/`tree`/`createdBy` single-row includes it
 * already handled before manyToMany existed. A `tree` field is a single-row FK like `reference` (to
 * its own model, always) — same LEFT JOIN plan, just self-joined. */
function referenceIncludeNames(model: ModelDefinition, includeNames: string[]): string[] {
  return includeNames.filter((name) => {
    if (name === 'createdBy') return true;
    const kind = model.fields[`${name}Id`]?.kind;
    return kind === 'reference' || kind === 'tree';
  });
}

function buildIncludePlans(
  model: ModelDefinition,
  registry: Record<string, ModelDefinition>,
  includeNames: string[],
): IncludePlan[] {
  return referenceIncludeNames(model, includeNames).map((relationName) => {
    // `createdBy` -> the auto-injected `createdById` column, always targeting `users` (see
    // parseInclude in router/query.ts) — not a declared `field.reference()`, so it has no entry
    // in `model.fields` to read a `targetModel` off of.
    if (relationName === 'createdBy') {
      const targetModel = registry['users'];
      if (!targetModel) throw new Error(`include 'createdBy': 'users' is not in the registry`);
      return { relationName, fkField: 'createdById', targetModel };
    }
    const fkField = `${relationName}Id`;
    const fieldDef = model.fields[fkField] as ReferenceFieldDefinition | TreeFieldDefinition;
    const targetModel = registry[fieldDef.targetModel];
    if (!targetModel) {
      throw new Error(`include '${relationName}': target model '${fieldDef.targetModel}' is not in the registry`);
    }
    return { relationName, fkField, targetModel };
  });
}

interface ManyToManyIncludePlan {
  relationName: string;
  relation: ManyToManyRelation;
  direction: 'forward' | 'reverse';
}

/** Resolves every `?include=` name that's a manyToMany relation (either direction) rather than a
 * `reference`/`createdBy` one — see `referenceIncludeNames`, its complement. */
function manyToManyIncludePlans(
  model: ModelDefinition,
  registry: Record<string, ModelDefinition>,
  includeNames: string[],
): ManyToManyIncludePlan[] {
  const plans: ManyToManyIncludePlan[] = [];
  for (const relationName of includeNames) {
    const forwardField = model.fields[relationName];
    if (forwardField?.kind === 'manyToMany') {
      plans.push({ relationName, relation: { sourceModel: model, fieldKey: relationName, fieldDef: forwardField }, direction: 'forward' });
      continue;
    }
    const reverse = findRelationsTargeting(registry, model.name).find((r) => r.sourceModel.name === relationName);
    if (reverse) plans.push({ relationName, relation: reverse, direction: 'reverse' });
  }
  return plans;
}

/** Populates every requested manyToMany include as an array on each row — deliberately a separate
 * step from the main SQL query (unlike a `reference` include's LEFT JOIN), since a many-side LEFT
 * JOIN would multiply each parent row once per match, breaking pagination/counting on the *primary*
 * result set. Two extra batched queries per include (junction rows, then target rows) regardless of
 * how many parent rows are in `rows` — no N+1. A target row that's soft-deleted (or otherwise
 * missing) is silently dropped from the array, matching how a dangling single reference already
 * doesn't surface (router/create-router.ts's `filterIncludedRelations` still applies field-level
 * grants to each array element afterward, same as any other included row). */
async function attachManyToManyIncludes(
  db: AnyDb,
  registry: Record<string, ModelDefinition>,
  rows: Record<string, unknown>[],
  plans: ManyToManyIncludePlan[],
): Promise<void> {
  if (rows.length === 0 || plans.length === 0) return;
  const ids = rows.map((r) => r.id as string);

  for (const plan of plans) {
    const cols = junctionColumnsOf(plan.relation);
    const junctionModel = buildJunctionModel(plan.relation);
    const ownColumn = plan.direction === 'forward' ? cols.sourceColumn : cols.targetColumn;
    const foreignColumn = plan.direction === 'forward' ? cols.targetColumn : cols.sourceColumn;
    const targetModel = plan.direction === 'forward' ? registry[plan.relation.fieldDef.targetModel] : plan.relation.sourceModel;
    if (!targetModel) continue; // validated already at parseInclude time — defensive only

    const junctionRows = await db.execute(
      sql`SELECT ${sql.identifier(toSnakeCase(ownColumn))} AS own_id, ${sql.identifier(toSnakeCase(foreignColumn))} AS foreign_id
          FROM ${tableIdent(junctionModel)}
          WHERE ${sql.identifier(toSnakeCase(ownColumn))} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND deleted_at IS NULL`,
    );

    const foreignIds = [...new Set(junctionRows.map((r) => r.foreign_id as string))];
    const targetById = new Map<string, Record<string, unknown>>();
    if (foreignIds.length > 0) {
      const targetCols = allColumnKeys(targetModel).map((key) => sql`${sql.identifier(toSnakeCase(key))} AS ${sql.identifier(key)}`);
      const targetRows = await db.execute(
        sql`SELECT ${sql.join(targetCols, sql`, `)} FROM ${tableIdent(targetModel)}
            WHERE id IN (${sql.join(foreignIds.map((id) => sql`${id}`), sql`, `)}) AND deleted_at IS NULL`,
      );
      for (const raw of targetRows) {
        const cleaned = deriveFileFields(targetModel, redactSensitiveFields(targetModel, normalizeTimestamps(targetModel, normalizeJsonFields(targetModel, raw))));
        targetById.set(cleaned.id as string, cleaned);
      }
    }

    const byOwnId = new Map<string, Record<string, unknown>[]>();
    for (const jr of junctionRows) {
      const targetRow = targetById.get(jr.foreign_id as string);
      if (!targetRow) continue;
      const ownId = jr.own_id as string;
      if (!byOwnId.has(ownId)) byOwnId.set(ownId, []);
      byOwnId.get(ownId)!.push(targetRow);
    }
    for (const row of rows) {
      row[plan.relationName] = byOwnId.get(row.id as string) ?? [];
    }
  }
}

interface ReferenceToManyIncludePlan {
  relationName: string;
  relation: ReferenceToManyRelation;
}

/** Resolves every `?include=` name that's a forward referenceToMany relation on this model (the
 * reverse direction is just the auto-injected `reference` field on the target, handled by the normal
 * `reference` include path via `referenceIncludeNames`). */
function referenceToManyIncludePlans(
  model: ModelDefinition,
  includeNames: string[],
): ReferenceToManyIncludePlan[] {
  const plans: ReferenceToManyIncludePlan[] = [];
  for (const relationName of includeNames) {
    const f = model.fields[relationName];
    if (f?.kind === 'referenceToMany') {
      plans.push({ relationName, relation: { sourceModel: model, fieldKey: relationName, fieldDef: f } });
    }
  }
  return plans;
}

/** Populates every requested forward referenceToMany include as an array on each row — like
 * `attachManyToManyIncludes`, a separate batched step (here one query per include: the target rows
 * whose inverse FK equals each parent id), so a child-side multiplicity never distorts the primary
 * result set's pagination/count. Soft-deleted or dangling children are silently dropped, same as
 * manyToMany. */
async function attachReferenceToManyIncludes(
  db: AnyDb,
  registry: Record<string, ModelDefinition>,
  rows: Record<string, unknown>[],
  plans: ReferenceToManyIncludePlan[],
): Promise<void> {
  if (rows.length === 0 || plans.length === 0) return;
  const parentIds = rows.map((r) => r.id as string);

  for (const plan of plans) {
    const targetModelName = plan.relation.fieldDef.targetModel;
    const targetModel = registry[targetModelName];
    if (!targetModel) continue; // validated already at parseInclude time — defensive only
    const inverseCol = inverseColumnName(plan.relation);

    const targetCols = allColumnKeys(targetModel).map((key) => sql`${sql.identifier(toSnakeCase(key))} AS ${sql.identifier(key)}`);
    const childRows = await db.execute(
      sql`SELECT ${sql.join(targetCols, sql`, `)} FROM ${sql.identifier(targetModelName)}
          WHERE ${sql.identifier(toSnakeCase(inverseCol))} IN (${sql.join(parentIds.map((id) => sql`${id}`), sql`, `)}) AND deleted_at IS NULL`,
    );

    const byParentId = new Map<string, Record<string, unknown>[]>();
    for (const raw of childRows) {
      const cleaned = deriveFileFields(targetModel, redactSensitiveFields(targetModel, normalizeTimestamps(targetModel, normalizeJsonFields(targetModel, rowToCamelCase(raw)))));
      const parentId = cleaned[inverseCol] as string | undefined;
      if (parentId === undefined) continue;
      if (!byParentId.has(parentId)) byParentId.set(parentId, []);
      byParentId.get(parentId)!.push(cleaned);
    }
    for (const row of rows) {
      row[plan.relationName] = byParentId.get(row.id as string) ?? [];
    }
  }
}

function filterClauseSql(model: ModelDefinition, clause: FilterClause, dialect: Dialect): SQL {
  const col = sql`t.${sql.identifier(toSnakeCase(clause.field))}`;
  switch (clause.op) {
    case '=':
      return sql`${col} = ${clause.value}`;
    case '!=':
      return sql`${col} != ${clause.value}`;
    case '>':
      return sql`${col} > ${clause.value}`;
    case '>=':
      return sql`${col} >= ${clause.value}`;
    case '<':
      return sql`${col} < ${clause.value}`;
    case '<=':
      return sql`${col} <= ${clause.value}`;
    case 'like':
      return sql`${col} LIKE ${clause.value}`;
    case 'ilike':
      // SQLite has no ILIKE — LOWER()-wrapped LIKE is portable and doesn't depend on the
      // process-wide `PRAGMA case_sensitive_like` setting the way plain LIKE would.
      return dialect === 'sqlite' ? sql`LOWER(${col}) LIKE LOWER(${clause.value})` : sql`${col} ILIKE ${clause.value}`;
    case 'is':
      if (clause.value !== null) {
        throw new PipelineError({
          code: 'INVALID_OPERATOR',
          status: 400,
          fields: { [clause.field]: "'is' only supports a null value" },
        });
      }
      return sql`${col} IS NULL`;
    case 'in': {
      const values = Array.isArray(clause.value) ? clause.value : [clause.value];
      if (values.length === 0) return sql`FALSE`;
      return sql`${col} IN (${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )})`;
    }
    case 'has': {
      // validated by router/query.ts's assertFilterable/assertValidOperator before this ever
      // runs — `has` is only ever paired with a manyToMany or referenceToMany field.
      const fieldDef = model.fields[clause.field];
      if (fieldDef?.kind === 'manyToMany') {
        const relation: ManyToManyRelation = { sourceModel: model, fieldKey: clause.field, fieldDef };
        const cols = junctionColumnsOf(relation);
        const junctionModel = buildJunctionModel(relation);
        return sql`EXISTS (SELECT 1 FROM ${tableIdent(junctionModel)} AS jt WHERE jt.${sql.identifier(toSnakeCase(cols.sourceColumn))} = t.id AND jt.${sql.identifier(toSnakeCase(cols.targetColumn))} = ${clause.value} AND jt.deleted_at IS NULL)`;
      }
      if (fieldDef?.kind === 'referenceToMany') {
        const relation: ReferenceToManyRelation = { sourceModel: model, fieldKey: clause.field, fieldDef };
        const inverseCol = inverseColumnName(relation);
        return sql`EXISTS (SELECT 1 FROM ${sql.identifier(fieldDef.targetModel)} AS jt WHERE jt.${sql.identifier(toSnakeCase(inverseCol))} = t.id AND jt.id = ${clause.value} AND jt.deleted_at IS NULL)`;
      }
      throw new PipelineError({ code: 'INVALID_OPERATOR', status: 400, fields: { [clause.field]: "'has' is only valid on a manyToMany or referenceToMany field" } });
    }
  }
}

function filterNodeSql(model: ModelDefinition, node: FilterNode, dialect: Dialect): SQL {
  if (!('logic' in node)) return filterClauseSql(model, node, dialect);
  // an empty group is vacuous: AND of nothing is true, OR of nothing is false.
  if (node.conditions.length === 0) return node.logic === 'and' ? sql`TRUE` : sql`FALSE`;
  const joiner = node.logic === 'and' ? sql` AND ` : sql` OR `;
  return sql`(${sql.join(
    node.conditions.map((c) => filterClauseSql(model, c, dialect)),
    joiner,
  )})`;
}

function selectListSql(model: ModelDefinition, includes: IncludePlan[]): SQL {
  const baseCols = allColumnKeys(model).map(
    (key) => sql`t.${sql.identifier(toSnakeCase(key))} AS ${sql.identifier(key)}`,
  );
  const relationCols = includes.flatMap((plan) =>
    allColumnKeys(plan.targetModel).map(
      (key) =>
        sql`${sql.identifier(plan.relationName)}.${sql.identifier(toSnakeCase(key))} AS ${sql.identifier(`${plan.relationName}__${key}`)}`,
    ),
  );
  return sql.join([...baseCols, ...relationCols], sql`, `);
}

function joinSql(model: ModelDefinition, includes: IncludePlan[]): SQL {
  return sql.join(
    includes.map(
      (plan) =>
        sql` LEFT JOIN ${sql.identifier(plan.targetModel.tableName)} AS ${sql.identifier(plan.relationName)} ON t.${sql.identifier(toSnakeCase(plan.fkField))} = ${sql.identifier(plan.relationName)}.${sql.identifier('id')}`,
    ),
    sql``,
  );
}

/** Reassembles `relation__field` aliased columns (see selectListSql) into nested objects. */
function nestRow(model: ModelDefinition, row: Record<string, unknown>, includes: IncludePlan[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const nested: Record<string, Record<string, unknown>> = {};
  for (const plan of includes) nested[plan.relationName] = {};

  for (const [key, value] of Object.entries(row)) {
    const relation = includes.find((p) => key.startsWith(`${p.relationName}__`));
    if (relation) {
      const subKey = key.slice(relation.relationName.length + 2);
      nested[relation.relationName]![subKey] = value;
    } else {
      out[key] = value;
    }
  }
  for (const plan of includes) {
    // a dangling/optional reference with no matching row still joins to all-NULL columns.
    const relRow = nested[plan.relationName]!;
    out[plan.relationName] =
      relRow.id === null
        ? null
        : deriveFileFields(plan.targetModel, redactSensitiveFields(plan.targetModel, normalizeTimestamps(plan.targetModel, normalizeJsonFields(plan.targetModel, relRow))));
  }
  return deriveFileFields(model, redactSensitiveFields(model, normalizeTimestamps(model, normalizeJsonFields(model, out))));
}

export interface OffsetPage {
  mode: 'offset';
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface CursorPage {
  mode: 'cursor';
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function listRows(
  db: AnyDb,
  model: ModelDefinition,
  registry: Record<string, ModelDefinition>,
  query: ParsedListQuery,
): Promise<OffsetPage | CursorPage> {
  const includes = buildIncludePlans(model, registry, query.include);
  const m2mPlans = manyToManyIncludePlans(model, registry, query.include);
  const refToManyPlans = referenceToManyIncludePlans(model, query.include);
  const tableIdent = sql.identifier(model.tableName);

  const whereParts: SQL[] = [];
  if (!query.includeDeleted) whereParts.push(sql`t.deleted_at IS NULL`);
  for (const node of query.filters) whereParts.push(filterNodeSql(model, node, db.dialect));

  // cursor-mode is opt-in via `?cursor=` and `query.ts` guarantees exactly one sort key for it.
  const cursorKey = query.cursorMode ? query.sort[0]! : undefined;

  if (cursorKey && query.cursor) {
    const sortCol = sql`t.${sql.identifier(toSnakeCase(cursorKey.field))}`;
    // Row-value tuple comparison (`(a, b) > (x, y)`) is Postgres-only — SQLite has no such syntax.
    // The boolean-expansion form below is equivalent and portable on both dialects, so it's used
    // unconditionally rather than branched.
    const cmp = cursorKey.direction === 'asc' ? sql`>` : sql`<`;
    whereParts.push(
      sql`(${sortCol} ${cmp} ${query.cursor.value} OR (${sortCol} = ${query.cursor.value} AND t.id ${cmp} ${query.cursor.id}))`,
    );
  }

  const whereSql = whereParts.length > 0 ? sql` WHERE ${sql.join(whereParts, sql` AND `)}` : sql``;
  const joinClause = joinSql(model, includes);
  const selectCols = selectListSql(model, includes);

  let orderSql: SQL;
  if (query.sort.length > 0) {
    const keyParts = query.sort.map(
      (k) => sql`t.${sql.identifier(toSnakeCase(k.field))} ${k.direction === 'asc' ? sql`ASC` : sql`DESC`}`,
    );
    // id tiebreak follows the last key's direction — a stable, total order (needed for cursor paging).
    const lastDir = query.sort[query.sort.length - 1]!.direction === 'asc' ? sql`ASC` : sql`DESC`;
    orderSql = sql` ORDER BY ${sql.join(keyParts, sql`, `)}, t.id ${lastDir}`;
  } else {
    orderSql = sql` ORDER BY t.created_at DESC, t.id DESC`;
  }

  if (cursorKey) {
    // cursor mode (§5): fetch one extra row to know whether another page exists.
    const rows = await db.execute(
      sql`SELECT ${selectCols} FROM ${tableIdent} AS t${joinClause}${whereSql}${orderSql} LIMIT ${query.limit + 1}`,
    );

    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map((r) => nestRow(model, r, includes));
    await attachManyToManyIncludes(db, registry, page, m2mPlans);
    await attachReferenceToManyIncludes(db, registry, page, refToManyPlans);

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = page[page.length - 1]!;
      nextCursor = encodeCursor({ value: last[cursorKey.field], id: last.id as string });
    }
    return { mode: 'cursor', rows: page, nextCursor, hasMore };
  }

  const rows = await db.execute(
    sql`SELECT ${selectCols} FROM ${tableIdent} AS t${joinClause}${whereSql}${orderSql} LIMIT ${query.limit} OFFSET ${query.offset}`,
  );

  // No `::int` cast — that's Postgres-only syntax. `COUNT(*)` is already integer-valued on both
  // dialects; the coercion below just protects against a driver returning it as a bigint/string.
  const countRows = await db.execute(sql`SELECT COUNT(*) AS count FROM ${tableIdent} AS t${whereSql}`);

  const page = rows.map((r) => nestRow(model, r, includes));
  await attachManyToManyIncludes(db, registry, page, m2mPlans);
  await attachReferenceToManyIncludes(db, registry, page, refToManyPlans);

  return {
    mode: 'offset',
    rows: page,
    total: Number(countRows[0]?.count ?? 0),
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getOneRow(
  db: AnyDb,
  model: ModelDefinition,
  registry: Record<string, ModelDefinition>,
  id: string,
  opts: { includeDeleted: boolean; include: string[] },
): Promise<Record<string, unknown> | null> {
  const includes = buildIncludePlans(model, registry, opts.include);
  const m2mPlans = manyToManyIncludePlans(model, registry, opts.include);
  const refToManyPlans = referenceToManyIncludePlans(model, opts.include);
  const tableIdent = sql.identifier(model.tableName);
  const joinClause = joinSql(model, includes);
  const selectCols = selectListSql(model, includes);
  const deletedClause = opts.includeDeleted ? sql`` : sql` AND t.deleted_at IS NULL`;

  const rows = await db.execute(
    sql`SELECT ${selectCols} FROM ${tableIdent} AS t${joinClause} WHERE t.id = ${id}${deletedClause} LIMIT 1`,
  );

  if (!rows[0]) return null;
  const row = nestRow(model, rows[0], includes);
  await attachManyToManyIncludes(db, registry, [row], m2mPlans);
  await attachReferenceToManyIncludes(db, registry, [row], refToManyPlans);
  return row;
}
