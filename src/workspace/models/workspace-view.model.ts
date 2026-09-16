import { z } from 'zod';
import { defineModel, field, pipe, validate, persist } from '../../core/index.js';
import { requireWorkspaceOwnership } from '../pipeline.js';

// a bare `field.json()` defaults to an object schema (z.record) — `filters`/`sort`/`include` are
// arrays, so each needs its own explicit shape (core/validation.ts's `baseSchemaForField` can't
// infer one).
//
// A filter entry is either a plain `[field, op, value]` clause, or a `[logic, [clauses]]` group —
// one level of `(a AND b)`/`(a OR b)` grouping around plain clauses, deliberately not recursive
// (no group-of-groups): mirrors `router/query.ts`'s `FilterNode`, whose doc comment explains why
// (keeps this a `z.union` with no `z.lazy`, which `zod-to-json-schema` — automation/tool.ts's
// LLM tool-schema derivation — can't turn into a clean non-recursive JSON Schema).
const filterClauseSchema = z.tuple([z.string(), z.string(), z.unknown()]);
const filterGroupSchema = z.tuple([z.enum(['and', 'or']), z.array(filterClauseSchema)]);
const filtersSchema = z.array(z.union([filterClauseSchema, filterGroupSchema]));
const includeSchema = z.array(z.string());
// an ordered list of sort keys, mirroring `router/query.ts`'s `SortKey[]` — `?sort=a,-b` round-trips
// through here as `[{ field: 'a', direction: 'asc' }, { field: 'b', direction: 'desc' }]`.
const sortSchema = z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }));

/**
 * One tab in a `Workspace` (workspace.model.ts): a saved filter/sort/columns configuration
 * against one model, in the exact shape `router/query.ts`'s `ParsedListQuery` already consumes —
 * so a view reopens (or an agent-driven edit re-renders) as the identical query a direct
 * `GET /api/:model?filter=...&sort=...` call would run.
 *
 * `userId` is denormalized from the parent `Workspace` (rather than derived through a join) so
 * `api: { ownerField: 'userId' }` can scope every route (read and write alike — see that field's
 * own doc comment, core/model.ts) the same simple way every other owner-scoped model does;
 * `requireWorkspaceOwnership` is what actually stops a view being attached to a workspace this
 * user doesn't own in the first place — the entry-point ownership check alone only protects the
 * view row's own ownership, not the parent it claims to belong to.
 *
 * `console: { hidden: true }`: managed only through the Workspace screen (console/client's
 * WorkspaceTabs/FilterBar) and agent tool calls (create_workspace_views/... — automation/tool.ts
 * derives these automatically from a role grant on 'workspace_views'), never the
 * generic sidebar.
 */
export const WorkspaceView = defineModel('workspace_views', {
  fields: {
    userId: field.reference('users', { required: true, indexed: true, displayText: 'Owner' }),
    workspaceId: field.reference('workspaces', { required: true, indexed: true, displayText: 'Workspace' }),
    targetModel: field.modelRef({ required: true, indexed: true, displayText: 'Model' }),
    label: field.string({ required: true, maxLength: 255 }),
    filters: field.json({ required: false, schema: filtersSchema }),
    sort: field.json({ required: false, schema: sortSchema }),
    include: field.json({ required: false, schema: includeSchema }),
    limit: field.integer({ default: 20 }),
    order: field.integer({ default: 0, indexed: true }),
  },
  operations: {
    create: pipe(validate, requireWorkspaceOwnership, persist),
    update: pipe(validate, requireWorkspaceOwnership, persist),
    remove: pipe(requireWorkspaceOwnership, persist.remove),
  },
  console: { hidden: true },
  api: { ownerField: 'userId' },
});
