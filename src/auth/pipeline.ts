import type { AnyDb } from '../core/db.js';
import type { ModelDefinition } from '../core/model.js';
import { pipe, validate, persist, PipelineError, type PipelineFn } from '../core/pipeline.js';
import { hashPassword as hashPasswordValue } from './password.js';
import { findSessionByToken, findUserById, listPermissionsForRole, type ActionGrant, type RolePermissions, type UserRow } from './lookup.js';
import { resolveSessionToken } from './cookie.js';

export type { ActionGrant, RolePermissions } from './lookup.js';


/** If `ctx.input.password` (plaintext) is present, replaces it with the model's real
 * `passwordHash` column before `validate` runs — a no-op when there's nothing to hash (e.g. a
 * `PATCH` that isn't touching the password). */
export const hashPassword: PipelineFn = async (ctx) => {
  const { password, ...rest } = ctx.input;
  if (typeof password !== 'string') return ctx;
  return { ...ctx, input: { ...rest, passwordHash: await hashPasswordValue(password) } };
};

/** Resolves a `Bearer` token to a live session + active user. Shared by the `requireAuth`
 * pipeline fn and the plain route handlers in `src/auth/router.ts` (e.g. `GET /me`) so both paths
 * apply the exact same session/expiry/active checks. Throws 401 UNAUTHENTICATED otherwise. */
export async function resolveSessionUser(db: AnyDb, request: Request | undefined): Promise<UserRow> {
  const token = resolveSessionToken(request);
  if (!token) throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'missing bearer token or session cookie' });

  const session = await findSessionByToken(db, token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'invalid or expired session' });
  }

  const user = await findUserById(db, session.userId);
  if (!user || !user.active) {
    throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'invalid or expired session' });
  }

  return user;
}

/** Resolves the bearer token on `ctx.request` to a live session + user, stashing the user on
 * `ctx.user` for `requirePermission`/business logic. Throws 401 UNAUTHENTICATED otherwise. */
export const requireAuth: PipelineFn = async (ctx) => {
  const user = await resolveSessionUser(ctx.db, ctx.request);
  return { ...ctx, user: user as unknown as Record<string, unknown> };
};

/** The most-specific-wins lookup behind every grant check: a resource key beats the top-level
 * `'*'` (checked only when the resource itself has no entry at all — never merged with it, even
 * to fill in an action the resource's own entry doesn't mention), and within whichever resource
 * entry was picked, a concrete action key beats that resource's own `'*'` action the same way.
 * Returns `undefined` when nothing matches (deny). */
function lookupActionGrant(permissions: RolePermissions, resource: string, action: string): ActionGrant | undefined {
  const resourceNode = permissions[resource] ?? permissions['*'];
  if (!resourceNode) return undefined;
  return resourceNode[action] ?? resourceNode['*'];
}

function permissionAllows(permissions: RolePermissions, resource: string, action: string): boolean {
  return lookupActionGrant(permissions, resource, action) !== undefined;
}

/** Requires `requireAuth` to have already run (`ctx.user` set), then checks the user's role owns
 * a permission matching `(resource, action)` — either side may be granted as `*`. Kept as a
 * pipeline fn (rather than being replaced outright by `authorizeRequest`) for library consumers
 * composing their own custom operations — the generic `/api/:model` router no longer needs a model
 * author to wire this in themselves, since it now applies implicitly (see `authorizeRequest`,
 * called directly by `create-router.ts` before a model's own pipeline ever runs). */
export function requirePermission(resource: string, action: string): PipelineFn {
  return async (ctx) => {
    if (ctx.user === undefined) {
      throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'requirePermission run before requireAuth' });
    }
    const roleId = ctx.user?.roleId;
    const permissions = typeof roleId === 'string' ? await listPermissionsForRole(ctx.db, roleId) : {};
    if (!permissionAllows(permissions, resource, action)) {
      throw new PipelineError({ code: 'FORBIDDEN', status: 403, message: `missing permission '${resource}:${action}'` });
    }
    return ctx;
  };
}

/** Router-level counterpart to `requirePermission`, for routes that never build an
 * `OperationContext` at all — the generic router's `GET` list/detail routes have no per-model
 * `read` operation to compose a pipeline fn into (unlike create/update/remove), so the
 * implicit read gate (`create-router.ts`) calls this directly instead, as does
 * `automation/tool.ts`'s agent-tool executor (the other caller that bypasses the router entirely).
 * Resolves the session user and checks their role holds `(resource, action)` — either side may be
 * `*` — the same rule `requirePermission` enforces. Throws 401 (no/expired session) or 403
 * (session valid, permission missing), same codes as `requirePermission`.
 *
 * Also returns the matched grant's `scope` (`'own'` | `'any'` | `undefined` if the grant didn't
 * specify one) — raw, as granted, not yet defaulted against the model's own `api.ownerField`
 * (only the caller knows the `ModelDefinition`, so it applies the "no `ownerField` -> scope is
 * meaningless; `ownerField` set + no explicit scope -> default `'own'`" rule itself). Returning it
 * from here (rather than a second `listPermissionsForRole` round-trip) keeps this at one DB lookup
 * per call, same as before. */
export async function authorizeRequest(
  db: AnyDb,
  request: Request | undefined,
  resource: string,
  action: string,
): Promise<{ user: UserRow; scope: 'own' | 'any' | undefined }> {
  const user = await resolveSessionUser(db, request);
  const permissions = typeof user.roleId === 'string' ? await listPermissionsForRole(db, user.roleId) : {};
  const grant = lookupActionGrant(permissions, resource, action);
  if (!grant) {
    throw new PipelineError({ code: 'FORBIDDEN', status: 403, message: `missing permission '${resource}:${action}'` });
  }
  return { user, scope: grant.scope };
}

export type GrantedFields = '*' | ReadonlySet<string>;

/** The field-level counterpart to `requirePermission`/`authorizeRequest`'s resource:action check —
 * resolves which fields of `resource` a role may touch/see for a field-shaped `action`
 * (`'read'`/`'create'`/`'update'`; meaningless for `'remove'`, which doesn't gate individual
 * fields at all). Secure-by-default (no backward-compat carve-out, ADR-less breaking change at
 * v0.1.0): a role with no matching grant, or a matching grant with no `fields` at all, gets an
 * empty set, not "everything" — see docs/content/docs/auth.mdx. */
export async function resolveGrantedFields(
  db: AnyDb,
  roleId: string | null | undefined,
  resource: string,
  action: string,
): Promise<GrantedFields> {
  const permissions = typeof roleId === 'string' ? await listPermissionsForRole(db, roleId) : {};
  const grant = lookupActionGrant(permissions, resource, action);
  if (!grant || grant.fields === undefined) return new Set();
  return grant.fields === '*' ? '*' : new Set(grant.fields);
}

/** Strips every `model.fields` key not in `granted` from `row` — used at every read boundary that
 * enforces field-level permission (the generic router's `GET` routes, `create-router.ts`; agent
 * tool-call output would need the same treatment if it's ever read-gated too). Auto-injected
 * system columns (`id`/`createdAt`/`updatedAt`/`deletedAt`/`createdById`) aren't in `model.fields`
 * at all, so this loop never reaches them — deliberately exempt, see docs/guide/auth.md. */
export function pickGrantedFields(model: ModelDefinition, row: Record<string, unknown>, granted: GrantedFields): Record<string, unknown> {
  if (granted === '*') return row;
  const out = { ...row };
  for (const key of Object.keys(model.fields)) {
    if (!granted.has(key)) delete out[key];
  }
  return out;
}

/** Maps a raw write-input key back to the `model.fields` key it actually writes — mainly for
 * `writeAs` (e.g. `User`'s `password` input key writes the real `passwordHash` field), so a role
 * denied write access to `passwordHash` can't route around that denial through its `writeAs`
 * alias. A key that isn't a real field at all resolves to `undefined` and is ignored by
 * `assertWriteFieldsAllowed` — `validate`'s schema silently strips it same as always. */
export function fieldKeyForInput(model: ModelDefinition, inputKey: string): string | undefined {
  if (inputKey in model.fields) return inputKey;
  return Object.entries(model.fields).find(([, f]) => f.writeAs === inputKey)?.[0];
}

/** Rejects the whole write (naming every offending key) if `input` touches a field outside
 * `granted` — used at every write boundary that enforces field-level permission: the generic
 * router's `POST`/`PATCH` (`create-router.ts`) and builtin agent tool calls (`automation/tool.ts`'s
 * `executeAgentTool`, which invokes a model's `create`/`update` pipeline exactly like the
 * REST route does and needs the identical check). Rejects rather than silently dropping disallowed
 * keys, so a caller's local state never disagrees with the server about what actually got written. */
export function assertWriteFieldsAllowed(model: ModelDefinition, input: Record<string, unknown>, granted: GrantedFields): void {
  if (granted === '*') return;
  const fields: Record<string, string> = {};
  for (const inputKey of Object.keys(input)) {
    const fieldKey = fieldKeyForInput(model, inputKey);
    if (fieldKey && !granted.has(fieldKey)) fields[inputKey] = 'field not permitted for your role';
  }
  if (Object.keys(fields).length > 0) throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
}

/**
 * The sugar helper behind a "convenient action" custom operation (core/model.ts's
 * `CustomOperationDefinition`) — e.g. `lock: presetFields({ locked: true })` is a whole `update`-
 * shaped write, minus having to hand-write one. Merges `values` on top of whatever's already in
 * `ctx.input` (a param-taking custom operation's already-validated params, or nothing for a plain
 * trigger like `lock`), checks the *combined* set against the caller's field-write permission for
 * `permissionAction` (default `'update'`) exactly as the generic router does for a real `PATCH`,
 * then runs it through the same `validate`+`persist` any `update` operation uses.
 *
 * This is deliberately *not* a bypass: per Q4/Q10, a custom operation's own action-level grant
 * (`resource:lock`) only gets you in the door — actually writing `locked` still needs the base
 * operation's own field grant (`resource:update` + `field:locked`), the same as if the caller had
 * PATCHed it directly. Must run where `ctx.user` is already set (i.e. after the router's own
 * resource-level authorization, which every custom-operation call already goes through — see
 * `create-router.ts`) so the right role's grants are resolved. `model.api?.public` skips the
 * check entirely, same carve-out `resolveFieldAccess` (create-router.ts) applies for a public
 * model's own create/update — there's no role to scope a grant by.
 */
export function presetFields(values: Record<string, unknown>, opts: { permissionAction?: string } = {}): PipelineFn {
  const permissionAction = opts.permissionAction ?? 'update';
  return async (ctx) => {
    const merged = { ...ctx.input, ...values };
    if (!ctx.model.api?.public) {
      const roleId = (ctx.user as { roleId?: string } | null | undefined)?.roleId;
      const granted = await resolveGrantedFields(ctx.db, roleId, ctx.model.name, permissionAction);
      assertWriteFieldsAllowed(ctx.model, merged, granted);
    }
    return pipe(validate, persist)({ ...ctx, input: merged });
  };
}

/** Actions that don't gate individual field values at all — currently just `remove`, which
 * deletes the whole row. A grant scoped to one of these must never carry a `field` value. (Kept
 * as a set so adding another whole-row action later is a one-line change.) */
export const FIELDLESS_ACTIONS: ReadonlySet<string> = new Set(['remove']);

/** The closed set of actions with a field-shaped permission concept at all. Everything else —
 * `remove`, and every developer-defined custom operation (core/model.ts's
 * `CustomOperationDefinition`, an open-ended, per-app vocabulary `FIELDLESS_ACTIONS` can't
 * enumerate) — is fieldless by default: a grant for it must never carry a `field` value. A custom
 * operation that does write specific fields (e.g. `presetFields()` below) gates those separately,
 * against its own field-shaped `update`-style action — not against its own operation name — so
 * e.g. `resource:lock` stays a whole-action grant while the actual `locked` write still needs
 * `resource:update` + `field:locked` (Q10). */
const FIELD_SHAPED_ACTIONS: ReadonlySet<string> = new Set(['read', 'create', 'update']);

/**
 * Checks a whole `Role.permissions` tree against the live model registry — the same checks
 * `Role.operations.create`/`.update` need run before persisting (`requireValidPermissions`
 * below), extracted into a pure function so anything else that needs to validate a tree (e.g. a
 * future console-side check) can reuse it without going through `ctx`/`PipelineError`. Returns a
 * path→message map (`permissions.<resource>`, `permissions.<resource>.<action>`, or
 * `permissions.<resource>.<action>.<fields|scope>`); empty means valid.
 *
 * At every level, sibling keys must be either exactly `{'*': ...}` alone or a set of specific
 * keys — never mixed (a resource/action grouping is either fully wildcard or fully enumerated, so
 * `lookupActionGrant`'s most-specific-wins lookup never has to merge two sources of truth).
 * `fields`'s requiredness is a cross-field constraint on the grant's own action (required for
 * `read`/`create`/`update`/`'*'`, forbidden for `remove` and every custom operation — see
 * `FIELD_SHAPED_ACTIONS`); a concrete field list is checked against the target model's fields
 * unless `resource` is `'*'`, where only `'*'` fields is meaningful (a concrete field can't be
 * checked against every model). `scope` needs no such check — every model has an owner by default
 * (`core/pipeline.ts`'s `ownerFieldOf`), so it's valid on any resource, including `'*'`.
 */
export function validateRolePermissions(
  registry: Record<string, ModelDefinition>,
  permissions: RolePermissions,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const resourceKeys = Object.keys(permissions);
  const validActions = new Set(['read', ...Object.values(registry).flatMap((model) => Object.keys(model.operations))]);

  if (resourceKeys.includes('*') && resourceKeys.length > 1) {
    errors['permissions.*'] = "cannot mix the '*' resource with specific resources — grant either everything or an explicit list";
    return errors;
  }

  for (const resource of resourceKeys) {
    if (resource !== '*' && !(resource in registry)) {
      errors[`permissions.${resource}`] = `unknown resource '${resource}' — must be a registered model name or '*'`;
      continue;
    }

    const actionMap = permissions[resource]!;
    const actionKeys = Object.keys(actionMap);
    if (actionKeys.includes('*') && actionKeys.length > 1) {
      errors[`permissions.${resource}.*`] = "cannot mix the '*' action with specific actions — grant either every action or an explicit list";
      continue;
    }

    for (const action of actionKeys) {
      const path = `permissions.${resource}.${action}`;
      if (action !== '*' && !validActions.has(action)) {
        errors[path] = `unknown action '${action}' — must be a real operation name, 'read', or '*'`;
        continue;
      }

      const grant = actionMap[action]!;
      const fieldApplicable = action === '*' || FIELD_SHAPED_ACTIONS.has(action);

      if (fieldApplicable) {
        if (grant.fields === undefined) {
          errors[`${path}.fields`] = `required for action '${action}' — name fields, or '*' for every field`;
        } else if (resource === '*' && grant.fields !== '*') {
          errors[`${path}.fields`] = `must be '*' when resource is '*' — a concrete field can't be checked against every model`;
        } else if (resource !== '*' && grant.fields !== '*') {
          const targetModel = registry[resource]!;
          const unknownField = grant.fields.find((f) => !(f in targetModel.fields));
          if (unknownField !== undefined) {
            errors[`${path}.fields`] = `unknown field '${unknownField}' on resource '${resource}'`;
          }
        }
      } else if (grant.fields !== undefined) {
        errors[`${path}.fields`] = `not applicable for action '${action}' — it doesn't gate individual fields, leave 'fields' unset`;
      }
    }
  }

  return errors;
}

/** Runs `validateRolePermissions` against `ctx.input.permissions` — the pipeline fn behind
 * `Role.operations.create`/`.update` (src/auth/models/role.model.ts). Skips entirely when
 * `permissions` isn't present in `ctx.input` at all (e.g. a `PATCH` that isn't touching it — the
 * tree stays whatever it already was). Requires `ctx.registry` (set by the router — see
 * `OperationContext.registry`). Throws one `VALIDATION_ERROR` if anything failed. */
export const requireValidPermissions: PipelineFn = async (ctx) => {
  if (!('permissions' in ctx.input)) return ctx;
  const permissions = (ctx.input.permissions as RolePermissions | undefined) ?? {};

  if (!ctx.registry) {
    throw new PipelineError({ code: 'INTERNAL', status: 500, message: 'requireValidPermissions requires ctx.registry' });
  }

  const fields = validateRolePermissions(ctx.registry, permissions);
  if (Object.keys(fields).length > 0) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
  }
  return ctx;
};

