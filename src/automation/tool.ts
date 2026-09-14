import { z } from 'zod';
import type { AnyDb } from '../core/db.js';
import type { CustomOperationDefinition, ModelDefinition, OperationContext, PipelineFn } from '../core/index.js';
import { buildCreateSchema, buildUpdateSchema, buildParamsSchema, PipelineError } from '../core/index.js';
import { authorizeRequest, resolveGrantedFields, assertWriteFieldsAllowed, pickGrantedFields } from '../auth/pipeline.js';
import { listPermissionsForRole } from '../auth/lookup.js';
import { listRows, getOneRow } from '../router/list.js';
import { parseListQuery, parseInclude } from '../router/query.js';
import { assertReadFieldsAllowed, filterIncludedRelations } from '../router/read-access.js';
import type { ToolSpec } from './events.js';


// The three builtin write verbs, exactly as `core`'s `Operation` names them — kept as its own
// list here so `expandGrant` has one source of truth for "which verbs every model always has".
const BUILTIN_OPERATIONS = ['create', 'update', 'remove'] as const;
type BuiltinOperation = (typeof BUILTIN_OPERATIONS)[number];

function isBuiltin(op: string): op is BuiltinOperation {
  return (BUILTIN_OPERATIONS as readonly string[]).includes(op);
}

// The two builtin read tools. Unlike the write verbs these aren't `core` `Operation` names — a
// model has no `read` pipeline (reads are served straight by `router/list.ts`, the same code the
// generic `GET /api/:model` routes call) — so they map to the permission system's implicit
// `'read'` action rather than a same-named operation. `executeAgentTool` branches on
// `isReadOperation` to run them through `listRows`/`getOneRow` with the identical field-grant
// enforcement `create-router.ts`'s GET routes apply.
const READ_OPERATIONS = ['list', 'findOne'] as const;
type ReadOperation = (typeof READ_OPERATIONS)[number];

function isReadOperation(op: string): op is ReadOperation {
  return (READ_OPERATIONS as readonly string[]).includes(op);
}

// The filter operators `router/query.ts` accepts (its `FilterOp`) — duplicated here as a runtime
// list so the `list` tool's params schema can constrain `op` to a real enum for the chatting model.
const FILTER_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'like', 'ilike', 'is', 'has'] as const;

/** Custom operations declared on a model (core/model.ts's `CustomOperationDefinition`) — every
 * `operations` key that isn't one of the three builtins. */
function customOperationNames(model: ModelDefinition): string[] {
  return Object.keys(model.operations).filter((op) => !isBuiltin(op));
}

export interface AgentTool {
  spec: ToolSpec;
  model: ModelDefinition;
  /** a builtin write verb (`create`/`update`/`remove`), a builtin read tool (`list`/`findOne`), or
   * the name of a custom operation declared on `model` — `executeAgentTool` branches on
   * `isReadOperation(operation)` then `isBuiltin(operation)`. */
  operation: string;
}

function toolName(operation: string, resource: string): string {
  return `${operation}_${resource}`;
}

/** Renders a tool's input schema to plain JSON Schema for the chat provider's `parameters`/
 * `input_schema`. `unrepresentable: 'any'` is needed because `datetime` fields
 * (core/validation.ts's `schemaForFieldKind`) accept `z.union([z.string(), z.date()])`, and
 * `z.date()` has no native JSON Schema representation — it renders as an unconstrained `{}`
 * member of the union rather than throwing. The `$schema` meta key is dropped; chat providers
 * expect a bare parameters object, not a standalone schema document. */
function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema, { unrepresentable: 'any' });
  return rest;
}

/** The `list` tool's params — a JSON-friendly rendering of the `?limit/offset/sort/filter/include`
 * query string the `GET /api/:model` route takes. `executeReadTool` turns a validated value back
 * into a `URLSearchParams` and runs it through the exact same `parseListQuery` the route uses, so
 * field/operator validation is identical. */
function listToolSchema(): z.ZodTypeAny {
  return z.object({
    filters: z
      .array(
        z.object({
          field: z.string(),
          op: z.enum(FILTER_OPERATORS),
          value: z.unknown(),
        }),
      )
      .optional()
      .describe(
        "AND-combined filter clauses. Only indexed fields are filterable. 'in' takes an array of values; 'is' only takes null; 'has' checks membership of a to-many relation by target id.",
      ),
    sort: z
      .string()
      .optional()
      .describe("comma-separated sort keys in priority order; prefix a key with '-' for descending, e.g. '-createdAt,name'"),
    limit: z.number().int().positive().max(100).optional().describe('max rows to return (default 20, max 100)'),
    offset: z.number().int().nonnegative().optional().describe('rows to skip before returning, for pagination'),
    include: z.array(z.string()).optional().describe('relation names to embed on each row'),
  });
}

/**
 * builtin read: `list` takes the paging/filter/sort/include params (`listToolSchema`); `findOne`
 * takes a record `id` plus optional `include`.
 *
 * builtin write: create's input is exactly the model's fields; update adds an `id` (there's no
 * route param to carry it here, unlike `/api/:model/:id`) to an otherwise-partial version of the
 * same fields; remove needs nothing but `id`.
 *
 * custom: a custom operation is always record-scoped (`POST /:model/:id/:operation`,
 * create-router.ts), so its input is its own declared `params` (validated the same way the route
 * validates them — `buildParamsSchema`) plus a required `id`. A param-less operation collapses to
 * just `{ id }`.
 */
function toolInputSchema(model: ModelDefinition, operation: string): z.ZodTypeAny {
  if (operation === 'list') return listToolSchema();
  if (operation === 'findOne') {
    return z.object({
      id: z.string().uuid(),
      include: z.array(z.string()).optional().describe('relation names to embed on the result'),
    });
  }
  if (operation === 'create') return buildCreateSchema(model);
  if (operation === 'update') return (buildUpdateSchema(model) as z.ZodObject<z.ZodRawShape>).extend({ id: z.string().uuid() });
  if (operation === 'remove') return z.object({ id: z.string().uuid() });

  const entry = model.operations[operation];
  const params = entry && typeof entry !== 'function' ? entry.params : undefined;
  return (buildParamsSchema(params ?? {}) as z.ZodObject<z.ZodRawShape>).extend({ id: z.string().uuid() });
}

/** The `description` a chatting model reads to decide when to call the tool. `model.description`
 * (when set) is appended to every tool for that model so the resource name isn't the only context;
 * a custom operation additionally prefers its own `description`, then `console.label`. */
function toolDescription(model: ModelDefinition, operation: string): string {
  const suffix = model.description ? ` ${model.description}` : '';
  if (isReadOperation(operation)) {
    const verb = {
      list: `List '${model.name}' rows. Supports filtering (indexed fields only), sorting, and offset pagination; returns { data, meta }.`,
      findOne: `Fetch a single '${model.name}' row by id.`,
    }[operation];
    return verb + suffix;
  }
  if (isBuiltin(operation)) {
    const verb = {
      create: `Create a new '${model.name}' row.`,
      update: `Update an existing '${model.name}' row by id.`,
      remove: `Delete a '${model.name}' row by id.`,
    }[operation];
    return verb + suffix;
  }
  const entry = model.operations[operation];
  const def: CustomOperationDefinition | undefined = entry && typeof entry !== 'function' ? entry : undefined;
  const base = def?.description ?? def?.console?.label ?? `Run the '${operation}' operation on a '${model.name}' row by id.`;
  return base + suffix;
}

/** Expands one grant's `(resource, action)` — either of which may be `'*'`, same wildcard
 * semantics `requirePermission` checks at call time (src/auth/pipeline.ts) — into concrete
 * `(model, operation)` pairs against the live registry. `action: '*'` covers the two read tools,
 * the three write builtins, *and* every custom operation each matched model declares; the implicit
 * `action: 'read'` maps to the `list`/`findOne` tools (there's no `read` operation on a model); any
 * other concrete `action` matches a write builtin or a custom operation of that exact name. */
function expandGrant(
  registry: Record<string, ModelDefinition>,
  resource: string,
  action: string,
): Array<{ model: ModelDefinition; operation: string }> {
  const models = resource === '*' ? Object.values(registry) : registry[resource] ? [registry[resource]] : [];
  return models.flatMap((model) => {
    const operations =
      action === '*'
        ? [...READ_OPERATIONS, ...BUILTIN_OPERATIONS, ...customOperationNames(model)]
        : action === 'read'
          ? [...READ_OPERATIONS]
          : isBuiltin(action) || model.operations[action]
            ? [action]
            : [];
    return operations.map((operation) => ({ model, operation }));
  });
}

/**
 * Resolves an `Agent`'s tools from its `Role`'s `permissions` array (src/auth/models/role.model.ts)
 * into callable tools — one per (model, operation) pair the grants expand to, deduplicated by
 * tool name (`<operation>_<resource>`, e.g. `create_invoice`, `lock_invoice`, `list_invoice`). A
 * `read` grant yields the `list_`/`findOne_` read tools; a write builtin's input schema is exactly
 * the target model's create/update Zod schema; a custom operation's is its declared `params` plus
 * a record `id`. An agent with no `roleId` (`null`/absent) is offered no tools at all.
 */
export async function resolveAgentTools(
  db: AnyDb,
  registry: Record<string, ModelDefinition>,
  roleId: string | null,
): Promise<AgentTool[]> {
  if (!roleId) return [];
  const grants = await listPermissionsForRole(db, roleId);
  const byName = new Map<string, AgentTool>();

  for (const grant of grants) {
    for (const { model, operation } of expandGrant(registry, grant.resource, grant.action)) {
      const name = toolName(operation, model.name);
      if (byName.has(name)) continue;
      byName.set(name, {
        model,
        operation,
        spec: {
          name,
          description: toolDescription(model, operation),
          parameters: toJsonSchema(toolInputSchema(model, operation)),
        },
      });
    }
  }

  return [...byName.values()];
}

function buildOpContext(
  tool: AgentTool,
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
  fields: { id: string | undefined; input: Record<string, unknown>; user: unknown },
): OperationContext {
  return {
    operation: tool.operation,
    id: tool.operation === 'create' ? undefined : fields.id,
    input: fields.input,
    doc: null,
    model: tool.model,
    db: ctx.db,
    request: ctx.request,
    registry: ctx.registry,
    user: fields.user as Record<string, unknown>,
  };
}

/**
 * Runs a granted tool call through the target model's own pipeline — the exact same call
 * `/api/:model` (builtin) or `/api/:model/:id/:operation` (custom) would make. Model pipelines no
 * longer carry their own `requireAuth`/`requirePermission` steps (the generic router applies both
 * implicitly — see `create-router.ts`), so this — the *other* caller that bypasses that router —
 * performs the identical checks itself, against the chat's own `request` (never the agent's own
 * role alone):
 *
 * - read (`list`/`findOne`): `authorizeRequest` for the `resource:read` grant, then the same
 *   `listRows`/`getOneRow` + `assertReadFieldsAllowed` + `pickGrantedFields` +
 *   `filterIncludedRelations` the generic `GET /api/:model` routes run — the `read` field grant
 *   scopes which columns come back and `?include=`d relations are filtered by their own model's
 *   grant, exactly as over REST. `api.ownerField` models are scoped to the chatting user's rows.
 * - builtin write: `authorizeRequest` for the `resource:action` grant, then `resolveGrantedFields`
 *   + `assertWriteFieldsAllowed` for create/update's field-level grant (`remove` has no field
 *   concept).
 * - custom: `authorizeRequest` for the `resource:<operation>` grant only — mirrors
 *   `create-router.ts`'s `resolveAccess(model, operationName)`. Whatever the operation's own
 *   pipeline writes is gated by that pipeline (e.g. `presetFields` re-checks the `update` field
 *   grant), not here.
 *
 * The agent's own `Role` only decided which tools it was offered; this is what stops it from
 * doing more than the chat's own user could already do via the REST API.
 */
export async function executeAgentTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
): Promise<unknown> {
  if (isReadOperation(tool.operation)) return executeReadTool(tool, input, ctx);
  return isBuiltin(tool.operation)
    ? executeBuiltinTool(tool, input, ctx)
    : executeCustomTool(tool, input, ctx);
}

/** Turns a validated `list` tool input back into the `?limit/offset/sort/filter/include` query
 * string `parseListQuery` parses — so filter/sort field names and operators are validated by the
 * same code path the `GET /api/:model` route uses, not re-implemented here. */
function listSearchParams(args: {
  filters?: { field: string; op: string; value: unknown }[];
  sort?: string;
  limit?: number;
  offset?: number;
  include?: string[];
}): URLSearchParams {
  const params = new URLSearchParams();
  if (typeof args.limit === 'number') params.set('limit', String(args.limit));
  if (typeof args.offset === 'number') params.set('offset', String(args.offset));
  if (args.sort) params.set('sort', args.sort);
  if (args.include && args.include.length > 0) params.set('include', args.include.join(','));
  if (args.filters && args.filters.length > 0) {
    params.set('filter', JSON.stringify(args.filters.map((f) => [f.field, f.op, f.value])));
  }
  return params;
}

async function executeReadTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
): Promise<unknown> {
  const parsed = toolInputSchema(tool.model, tool.operation).safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid input for '${tool.operation}': ${detail}`);
  }
  const args = parsed.data as Record<string, unknown>;

  // Same "the chatting user, never the agent alone" gate the write paths use — here for the
  // implicit `read` action, exactly as `create-router.ts`'s GET routes call `authorizeRequest`.
  const user = await authorizeRequest(ctx.db, ctx.request, tool.model.name, 'read');
  const granted = await resolveGrantedFields(ctx.db, user.roleId, tool.model.name, 'read');
  const ownerField = tool.model.api?.ownerField;

  if (tool.operation === 'findOne') {
    const id = args.id as string;
    const includeArg = (args.include as string[] | undefined) ?? [];
    const include = parseInclude(tool.model, includeArg.length > 0 ? includeArg.join(',') : null, ctx.registry);
    const row = await getOneRow(ctx.db, tool.model, ctx.registry, id, { includeDeleted: false, include });
    if (!row || (ownerField && row[ownerField] !== user.id)) {
      throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    }
    await filterIncludedRelations(ctx.db, ctx.registry, tool.model, row, include, user.roleId);
    return pickGrantedFields(tool.model, row, granted);
  }

  const query = parseListQuery(
    tool.model,
    listSearchParams(args as Parameters<typeof listSearchParams>[0]),
    ctx.registry,
  );
  assertReadFieldsAllowed(tool.model, query, granted);
  if (ownerField) query.filters.push({ field: ownerField, op: '=', value: user.id });

  const page = await listRows(ctx.db, tool.model, ctx.registry, query);
  for (const row of page.rows) {
    await filterIncludedRelations(ctx.db, ctx.registry, tool.model, row, query.include, user.roleId);
  }
  const rows = page.rows.map((row) => pickGrantedFields(tool.model, row, granted));
  return page.mode === 'offset'
    ? { data: rows, meta: { total: page.total, limit: page.limit, offset: page.offset } }
    : { data: rows, meta: { nextCursor: page.nextCursor, hasMore: page.hasMore } };
}

async function executeBuiltinTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
): Promise<unknown> {
  const user = await authorizeRequest(ctx.db, ctx.request, tool.model.name, tool.operation);

  const { id, ...rest } = input as { id?: string } & Record<string, unknown>;
  const writeInput = tool.operation === 'create' ? input : rest;

  if (tool.operation === 'create' || tool.operation === 'update') {
    const granted = await resolveGrantedFields(ctx.db, user.roleId, tool.model.name, tool.operation);
    assertWriteFieldsAllowed(tool.model, writeInput, granted);
  }

  const result = await tool.model.operations[tool.operation as BuiltinOperation](
    buildOpContext(tool, ctx, { id, input: writeInput, user }),
  );
  return result.doc;
}

async function executeCustomTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
): Promise<unknown> {
  const entry = tool.model.operations[tool.operation];
  if (!entry) throw new Error(`operation '${tool.operation}' no longer exists on '${tool.model.name}'`);
  const def: CustomOperationDefinition | undefined = typeof entry === 'function' ? undefined : entry;
  const pipelineFn: PipelineFn = typeof entry === 'function' ? entry : entry.pipeline;

  // Resource-level "can this role invoke this operation at all" gate only — same as
  // create-router.ts's `resolveAccess(model, operationName)`.
  const user = await authorizeRequest(ctx.db, ctx.request, tool.model.name, tool.operation);

  const { id, ...rest } = input as { id?: string } & Record<string, unknown>;
  if (typeof id !== 'string') throw new Error(`'${tool.operation}' needs an 'id' (custom operations are record-scoped)`);

  let params: Record<string, unknown> = {};
  if (def?.params) {
    const parsed = buildParamsSchema(def.params).safeParse(rest);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`invalid params for '${tool.operation}': ${detail}`);
    }
    params = parsed.data as Record<string, unknown>;
  }

  const result = await pipelineFn(buildOpContext(tool, ctx, { id, input: params, user }));
  return result.doc;
}
