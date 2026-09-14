import type { AnyDb } from '../core/db.js';
import type { ModelDefinition } from '../core/model.js';
import { pipe, validate, persist, PipelineError, type PipelineFn } from '../core/pipeline.js';
import { hashPassword as hashPasswordValue } from './password.js';
import { findSessionByToken, findUserById, listPermissionsForRole, type UserRow } from './lookup.js';
import { resolveSessionToken } from './cookie.js';


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

function permissionAllows(permissions: { resource: string; action: string }[], resource: string, action: string): boolean {
  return permissions.some((p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'));
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
    const permissions = typeof roleId === 'string' ? await listPermissionsForRole(ctx.db, roleId) : [];
    if (!permissionAllows(permissions, resource, action)) {
      throw new PipelineError({ code: 'FORBIDDEN', status: 403, message: `missing permission '${resource}:${action}'` });
    }
    return ctx;
  };
}

/** Router-level counterpart to `requirePermission`, for routes that never build an
 * `OperationContext` at all — the generic router's `GET` list/detail routes have no per-model
 * `read` operation to compose a pipeline fn into (unlike create/update/remove), so the
 * implicit read gate (`create-router.ts`) calls this directly instead. Resolves the session user
 * and checks their role holds `(resource, action)` — either side may be `*` — the same rule
 * `requirePermission` enforces. Throws 401 (no/expired session) or 403 (session valid, permission
 * missing), same codes as `requirePermission`. */
export async function authorizeRequest(db: AnyDb, request: Request | undefined, resource: string, action: string): Promise<UserRow> {
  const user = await resolveSessionUser(db, request);
  const permissions = typeof user.roleId === 'string' ? await listPermissionsForRole(db, user.roleId) : [];
  if (!permissionAllows(permissions, resource, action)) {
    throw new PipelineError({ code: 'FORBIDDEN', status: 403, message: `missing permission '${resource}:${action}'` });
  }
  return user;
}

export type GrantedFields = '*' | ReadonlySet<string>;

/** The field-level counterpart to `requirePermission`/`authorizeRequest`'s resource:action check —
 * resolves which fields of `resource` a role may touch/see for a field-shaped `action`
 * (`'read'`/`'create'`/`'update'`; meaningless for `'remove'`, which doesn't gate individual
 * fields at all). Unions every matching grant's `field` (the grant's own `resource`/`action`
 * sides may each independently be `'*'`); any matching grant with `field: '*'` short-circuits to
 * "every field." Secure-by-default (no backward-compat carve-out, ADR-less breaking change at
 * v0.1.0): a role with *no* matching field-scoped grant gets an empty set, not "everything" —
 * see docs/guide/auth.md. */
export async function resolveGrantedFields(
  db: AnyDb,
  roleId: string | null | undefined,
  resource: string,
  action: string,
): Promise<GrantedFields> {
  const permissions = typeof roleId === 'string' ? await listPermissionsForRole(db, roleId) : [];
  const matching = permissions.filter(
    (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
  );
  if (matching.some((p) => p.field === '*')) return '*';
  return new Set(matching.map((p) => p.field).filter((f): f is string => typeof f === 'string'));
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

/** One desired grant — an element of `Role.permissions` (src/auth/models/role.model.ts). Mirrors
 * the resource/action/field triple the old `Permission` row carried, minus `roleId` (implied by
 * which role's array it lives in). */
export interface PermissionTarget {
  resource: string;
  action: string;
  field?: string | null;
}

/**
 * Checks one `PermissionTarget` against the live model registry — the same checks
 * `Role.operations.create`/`.update` need run against every entry of `permissions`, extracted
 * into a pure function so both a single-target pipeline fn (`requireValidPermissions` below) and
 * anything else that needs to validate a target (e.g. a future console-side check) can reuse it
 * without going through `ctx`/`PipelineError`. Returns a field→message map; empty means valid.
 *
 * `resource`/`action` empty-string checks are skipped when the corresponding key is `undefined`
 * (so a caller validating a fully-specified target never needs to pre-fill both) or `'*'`.
 * `field`'s requiredness is a cross-field constraint that depends on the target's own *effective*
 * `action` (required for `read`/`create`/`update`/`*`, forbidden for `remove` and every custom
 * operation — see `FIELD_SHAPED_ACTIONS`) — every target has a `field` concept.
 */
export function validatePermissionTarget(
  registry: Record<string, ModelDefinition>,
  target: { resource?: unknown; action?: unknown; field?: unknown },
): Record<string, string> {
  const { resource, action, field } = target;
  const resourceNeedsCheck = resource !== undefined && resource !== '*';
  const actionNeedsCheck = action !== undefined && action !== '*';

  const fields: Record<string, string> = {};

  if (resourceNeedsCheck && (typeof resource !== 'string' || !(resource in registry))) {
    fields.resource = `unknown resource '${String(resource)}' — must be a registered model name or '*'`;
  }

  if (actionNeedsCheck) {
    const validActions = new Set(['read', ...Object.values(registry).flatMap((model) => Object.keys(model.operations))]);
    if (typeof action !== 'string' || !validActions.has(action)) {
      fields.action = `unknown action '${String(action)}' — must be a real operation name, 'read', or '*'`;
    }
  }

  // Only cross-check `field` once `resource`/`action` are themselves known-valid — an invalid
  // action makes "is field required for it" unanswerable.
  if (fields.resource === undefined && fields.action === undefined) {
    const effectiveAction = typeof action === 'string' ? action : undefined;
    const effectiveResource = typeof resource === 'string' ? resource : undefined;

    if (effectiveAction !== undefined) {
      const fieldApplicable = effectiveAction === '*' || FIELD_SHAPED_ACTIONS.has(effectiveAction);

      if (!fieldApplicable) {
        if (field !== undefined && field !== null) {
          fields.field = `not applicable for action '${effectiveAction}' — it doesn't gate individual fields, leave 'field' unset`;
        }
      } else if (field === undefined || field === null || field === '') {
        fields.field = `required for action '${effectiveAction}' — name a field, or '*' for every field`;
      } else if (typeof field === 'string' && field !== '*') {
        if (effectiveResource === '*') {
          fields.field = `must be '*' when resource is '*' — a concrete field can't be checked against every model`;
        } else if (typeof effectiveResource === 'string') {
          const targetModel = registry[effectiveResource];
          if (!targetModel || !(field in targetModel.fields)) {
            fields.field = `unknown field '${field}' on resource '${effectiveResource}'`;
          }
        }
      }
    }
  }

  return fields;
}

/** Runs `validatePermissionTarget` over every entry of `ctx.input.permissions` — the pipeline fn
 * behind `Role.operations.create`/`.update` (src/auth/models/role.model.ts). Skips entirely when
 * `permissions` isn't present in `ctx.input` at all (e.g. a `PATCH` that isn't touching it — the
 * array stays whatever it already was). Requires `ctx.registry` (set by the router — see
 * `OperationContext.registry`). Collects every invalid entry's errors keyed `permissions.<idx>.
 * <field>` and throws one `VALIDATION_ERROR` if any entry failed. */
export const requireValidPermissions: PipelineFn = async (ctx) => {
  if (!('permissions' in ctx.input)) return ctx;
  const targets = (ctx.input.permissions as PermissionTarget[] | undefined) ?? [];

  if (!ctx.registry) {
    throw new PipelineError({ code: 'INTERNAL', status: 500, message: 'requireValidPermissions requires ctx.registry' });
  }

  const fields: Record<string, string> = {};
  targets.forEach((target, index) => {
    const targetFields = validatePermissionTarget(ctx.registry!, target);
    for (const [key, message] of Object.entries(targetFields)) fields[`permissions.${index}.${key}`] = message;
  });

  if (Object.keys(fields).length > 0) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
  }
  return ctx;
};

