import type { ModelDefinition } from '../core/model.js';
import { findRelationsTargeting } from '../core/many-to-many.js';
import { PipelineError } from '../core/pipeline.js';
import { columnKind, isFilterableOrSortable, isKnownColumn, isOperatorValidForKind } from './fields.js';

export type FilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'like' | 'ilike' | 'is' | 'has';
const VALID_OPS: ReadonlySet<string> = new Set(['=', '!=', '>', '>=', '<', '<=', 'in', 'like', 'ilike', 'is', 'has']);
const GROUP_LOGICS: ReadonlySet<string> = new Set(['and', 'or']);

export interface FilterClause {
  field: string;
  op: FilterOp;
  value: unknown;
}

export type FilterGroupLogic = 'and' | 'or';

/** One level of `(a AND b)` / `(a OR b)` grouping around plain clauses — deliberately not
 * recursive (no group-of-groups): keeps the wire shape a `zod` union free of `z.lazy`, which
 * `zod-to-json-schema` (the automation plugin's `agents/tool.ts`'s LLM tool-schema derivation) can't turn into a clean
 * non-recursive JSON Schema, and keeps `FilterBar`'s UI a single flat level to build by hand. */
export interface FilterGroup {
  logic: FilterGroupLogic;
  conditions: FilterClause[];
}

export type FilterNode = FilterClause | FilterGroup;

export interface CursorState {
  value: unknown;
  id: string;
}

export type SortDirection = 'asc' | 'desc';

export interface SortKey {
  field: string;
  direction: SortDirection;
}

export interface ParsedListQuery {
  limit: number;
  offset: number;
  /** ordered list of sort keys — `?sort=status,-createdAt` → `[{status,asc},{createdAt,desc}]`.
   * Empty means the endpoint's default ordering (`created_at DESC`). */
  sort: SortKey[];
  /** `?cursor=` was present (even empty, for the first page) — opt in to cursor-mode pagination.
   * Requires exactly one `sort` key. A bare `?sort=` stays offset-mode with the ordering applied. */
  cursorMode: boolean;
  cursor?: CursorState;
  includeDeleted: boolean;
  include: string[];
  filters: FilterNode[];
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RESERVED_PARAMS = new Set(['limit', 'offset', 'sort', 'cursor', 'include', 'filter', 'includeDeleted']);

function parseLimit(raw: string | null): number {
  const n = raw === null ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  // Q16: over-the-max is clamped, not rejected — unlike a malformed sort/filter request.
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: string | null): number {
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return !Number.isFinite(n) || n < 0 ? 0 : n;
}

function decodeCursor(raw: string): CursorState {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'value' in decoded &&
      'id' in decoded &&
      typeof (decoded as { id: unknown }).id === 'string'
    ) {
      return { value: (decoded as { value: unknown }).value, id: (decoded as { id: string }).id };
    }
  } catch {
    // fall through to the error below
  }
  throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { cursor: 'malformed cursor' } });
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function parseInclude(model: ModelDefinition, raw: string | null, registry: Record<string, ModelDefinition>): string[] {
  if (!raw) return [];
  return raw.split(',').map((name) => {
    const trimmed = name.trim();
    if (trimmed.includes('.')) {
      // Q20: multi-hop/dot-chained include is rejected outright, not silently truncated.
      throw new PipelineError({ code: 'INVALID_INCLUDE', status: 400, fields: { include: `nested include '${trimmed}' is not supported` } });
    }
    // `createdBy` is the one relation name that isn't a declared `field.reference()` — it maps to
    // the auto-injected `createdById` column (core/model.ts, schema-gen.ts) instead of a model field.
    if (trimmed === 'createdBy') return trimmed;
    // forward manyToMany: declared directly on this model, include name === the field key.
    if (model.fields[trimmed]?.kind === 'manyToMany') return trimmed;
    // forward referenceToMany: declared directly on this model, include name === the field key
    // (it expands to the array of target rows whose inverse FK points at this row).
    if (model.fields[trimmed]?.kind === 'referenceToMany') return trimmed;
    // reverse manyToMany: declared on some *other* model targeting this one — no matching
    // declaration needed here (round 3 of the design discussion: declaring once makes both
    // directions queryable). The include name is that other model's own name, e.g. `?include=posts`
    // on `Tag` for a relation only `Post` ever declared.
    if (findRelationsTargeting(registry, model.name).some((r) => r.sourceModel.name === trimmed)) return trimmed;
    const fieldKey = `${trimmed}Id`;
    const field = model.fields[fieldKey];
    if (!field || (field.kind !== 'reference' && field.kind !== 'tree')) {
      throw new PipelineError({ code: 'INVALID_INCLUDE', status: 400, fields: { include: `unknown relation '${trimmed}'` } });
    }
    return trimmed;
  });
}

type RawClause = [string, string, unknown];
type RawGroup = [FilterGroupLogic, RawClause[]];

function parseRawClause(entry: unknown): RawClause {
  if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
    throw new PipelineError({
      code: 'VALIDATION_ERROR',
      status: 400,
      fields: { filter: 'each entry must be [field, operator, value] or [logic, [clauses]]' },
    });
  }
  return entry as RawClause;
}

function isRawGroup(entry: unknown): entry is RawGroup {
  return Array.isArray(entry) && entry.length === 2 && GROUP_LOGICS.has(entry[0] as string) && Array.isArray(entry[1]);
}

/** Top level stays a flat, implicitly-AND'd array (unchanged wire shape for plain filters); an
 * entry may itself be a `[logic, [clauses]]` group of clauses OR'd/AND'd together, one level deep
 * (see `FilterGroup`'s doc comment on why no group-of-groups). */
function parseStructuredFilters(raw: string | null): (RawClause | RawGroup)[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { filter: 'must be valid JSON' } });
  }
  if (!Array.isArray(parsed)) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { filter: 'must be an array of [field, operator, value] triples' } });
  }
  return parsed.map((entry) => (isRawGroup(entry) ? [entry[0], entry[1].map(parseRawClause)] : parseRawClause(entry)));
}

function assertFilterable(model: ModelDefinition, field: string): void {
  if (!isKnownColumn(model, field)) {
    throw new PipelineError({ code: 'UNFILTERABLE_FIELD', status: 400, fields: { [field]: 'not indexed — cannot be filtered on' } });
  }
  // manyToMany has no `indexed` flag to gate on (there's no column) — its filterability is gated
  // purely by operator instead (`has` only, enforced by assertValidOperator/OPERATORS_BY_KIND).
  if (columnKind(model, field) === 'manyToMany') return;
  // referenceToMany is the same: no column on this model, filterable only via `has`
  // (router/list.ts's filterClauseSql issues an EXISTS over the target's inverse FK).
  if (columnKind(model, field) === 'referenceToMany') return;
  if (!isFilterableOrSortable(model, field)) {
    throw new PipelineError({ code: 'UNFILTERABLE_FIELD', status: 400, fields: { [field]: 'not indexed — cannot be filtered on' } });
  }
}

/** Same underlying gate as assertFilterable (Q10: one `indexed` flag serves both), but §5
 * specifies a distinct error code for the sort case. */
function assertSortable(model: ModelDefinition, field: string): void {
  if (!isKnownColumn(model, field) || !isFilterableOrSortable(model, field)) {
    throw new PipelineError({ code: 'UNSORTABLE_FIELD', status: 400, fields: { [field]: 'not indexed — cannot be sorted on' } });
  }
}

/** `?sort=` is a comma-separated list of `field` (asc) / `-field` (desc) keys, in priority order.
 * Empty segments are skipped and a field repeated across segments keeps only its first appearance,
 * so a hand-edited `?sort=name,,-name` still parses to a single well-formed key list. */
function parseSort(model: ModelDefinition, raw: string | null): SortKey[] {
  if (!raw) return [];
  const out: SortKey[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const direction: SortDirection = trimmed.startsWith('-') ? 'desc' : 'asc';
    const field = trimmed.replace(/^-/, '');
    assertSortable(model, field);
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, direction });
  }
  return out;
}

function assertValidOperator(model: ModelDefinition, field: string, op: string): asserts op is FilterOp {
  if (!VALID_OPS.has(op)) {
    throw new PipelineError({ code: 'INVALID_OPERATOR', status: 400, fields: { [field]: `unknown operator '${op}'` } });
  }
  const kind = columnKind(model, field);
  if (!isOperatorValidForKind(kind, op)) {
    throw new PipelineError({ code: 'INVALID_OPERATOR', status: 400, fields: { [field]: `operator '${op}' is not valid for a ${kind} field` } });
  }
}

export function parseListQuery(
  model: ModelDefinition,
  searchParams: URLSearchParams,
  registry: Record<string, ModelDefinition>,
): ParsedListQuery {
  const sort = parseSort(model, searchParams.get('sort'));

  const cursorRaw = searchParams.get('cursor');
  // `?cursor=` (present at all, even empty for the first page) opts into cursor-mode pagination; a
  // bare `?sort=` stays offset-mode with the ordering applied.
  const cursorMode = cursorRaw !== null;
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;
  if (cursorMode && sort.length === 0) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { cursor: 'requires ?sort=<field>' } });
  }
  if (cursorMode && sort.length > 1) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { cursor: 'cursor pagination supports a single sort field' } });
  }

  const filters: FilterNode[] = [];

  for (const entry of parseStructuredFilters(searchParams.get('filter'))) {
    if (isRawGroup(entry)) {
      const [logic, clauses] = entry;
      const conditions = clauses.map(([field, op, value]) => {
        assertFilterable(model, field);
        assertValidOperator(model, field, op);
        return { field, op: op as FilterOp, value };
      });
      filters.push({ logic, conditions });
    } else {
      const [field, op, value] = entry;
      assertFilterable(model, field);
      assertValidOperator(model, field, op);
      filters.push({ field, op: op as FilterOp, value });
    }
  }

  for (const [key, value] of searchParams.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    assertFilterable(model, key);
    if (columnKind(model, key) === 'manyToMany' || columnKind(model, key) === 'referenceToMany') {
      // a bare `?tags=x` has no operator to carry `has` — reject it with a clear message rather
      // than silently falling through to `=`, which would try (and fail) to compare a nonexistent
      // `tags` column.
      throw new PipelineError({
        code: 'INVALID_OPERATOR',
        status: 400,
        fields: { [key]: `${columnKind(model, key)} field requires the structured filter syntax, e.g. ?filter=[["${key}","has","<id>"]]` },
      });
    }
    filters.push({ field: key, op: '=', value });
  }

  return {
    limit: parseLimit(searchParams.get('limit')),
    offset: parseOffset(searchParams.get('offset')),
    sort,
    cursorMode,
    cursor,
    includeDeleted: searchParams.get('includeDeleted') === 'true',
    include: parseInclude(model, searchParams.get('include'), registry),
    filters,
  };
}
