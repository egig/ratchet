import type { FieldDefinition, ReferenceFieldDefinition, TreeFieldDefinition } from './field.js';
import { pipe, validate, persist, type PipelineFn } from './pipeline.js';

/** Shows/hides a custom operation's console button based on the record's own current data — e.g.
 * a `lock` operation is only offered while `locked === false`. Evaluated client-side against the
 * row the console already has, since a `PipelineFn` can't cross the wire to the console SPA (see
 * `console/serialize-model.ts`) — this has to stay a small, JSON-serializable shape instead of
 * arbitrary code. Exactly one of `equals`/`notEquals`/`in` should be set. */
export interface OperationVisibilityRule {
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: readonly unknown[];
}

/** Console-facing presentation for a custom operation — entirely optional; an operation with no
 * `console` block still renders (as a row-action button with a humanized-name label), this just
 * customizes it. Mirrors `ConsoleModelOptions`' role for a whole model. */
export interface OperationConsoleOptions {
  /** button label; defaults to the operation's key, humanized. */
  label?: string;
  /** `true` shows a generic "Are you sure?" browser confirm; a string is shown as the confirm
   * message instead. Omit for no confirmation. */
  confirm?: boolean | string;
  /** where the button appears. `'bulk'` only takes effect for a param-less operation (Q17: a
   * bulk-selected action re-invokes the single-record operation once per selected row, and there's
   * no console UI yet for collecting one set of params to apply to every row). Defaults to `['row']`. */
  placement?: readonly ('row' | 'detail' | 'bulk')[];
  visibleWhen?: OperationVisibilityRule;
}

/**
 * A developer-defined operation beyond the three builtins — the mechanism behind "convenient
 * actions" like a `lock`/`unlock` button that's really an `update` with a fixed field value (see
 * `presetFields()`, core/pipeline.ts). Lives as an extra key directly in a model's `operations`
 * object (`OperationsConfig`) rather than a separate map, so it's picked up for free everywhere
 * `Object.keys(model.operations)` already drives behavior: the console's operation list
 * (`operationNames`/`operations` in `console/serialize-model.ts`), the `actionRef` field's
 * dropdown (`console/client/fields.tsx`), and `validateRolePermissions`'s action-name
 * validation (ratchet/auth). Dispatched by one generic route, `POST /:model/:id/:operation`
 * (router/create-router.ts) — always record-scoped, always POST, regardless of what `pipeline`
 * does internally.
 */
export interface CustomOperationDefinition {
  pipeline: PipelineFn;
  /** one-line explanation of what this operation does — shown as console help and, when the
   * operation is exposed to an `Agent` as a tool (src/automation/tool.ts), used verbatim as the
   * tool description a chatting model reads to decide when to call it. Falls back to
   * `console.label` then a humanized operation name. */
  description?: string;
  /** input params, declared with the same `field.*()` builder DSL as model fields — optional; a
   * paramless operation is a plain trigger (e.g. `lock`). When present, the console renders a
   * small modal form built from these before calling the operation. */
  params?: Record<string, FieldDefinition>;
  console?: OperationConsoleOptions;
}

/** A value in `OperationsConfig` beyond the three builtins: either a plain `PipelineFn` (a fully
 * custom operation with no params/console config) or a `CustomOperationDefinition` (adds params
 * and/or console presentation). */
export type OperationEntry = PipelineFn | CustomOperationDefinition;

/** Operation names no model may declare a custom operation under — `create`/`update`/`remove` are
 * the fixed builtin keys (typed separately below); `read` and `*` are reserved by the permission
 * system (`ratchet/auth`'s `validateRolePermissions`); `query` is reserved by a workflow's Model
 * Operation step, whose `operation` field also accepts the built-in record actions alongside
 * custom operation names (`BUILTIN_ACTIONS`, workflows/graph.ts); `upload` is reserved because
 * `POST /:model/:field/upload` (router/create-router.ts) already occupies that exact path shape
 * for models with a `file` field. */
export const RESERVED_OPERATION_NAMES: ReadonlySet<string> = new Set([
  'create',
  'update',
  'remove',
  'read',
  'query',
  'upload',
  '*',
]);

export interface OperationsConfig {
  create: PipelineFn;
  update: PipelineFn;
  remove: PipelineFn;
  [operationName: string]: OperationEntry;
}

export interface ConsoleModelOptions {
  /** excluded from the console sidebar and the `/meta/models` metadata endpoint entirely —
   * e.g. the built-in `Session` model, which is managed only through `/api/auth/*`. */
  hidden?: boolean;
  /** sidebar/heading text; defaults to a capitalized `name` when omitted. */
  label?: string;
  /** field key shown for a record in reference-field dropdowns and list-view titles; when
   * omitted, defaults to the first `string`-kind field declared on the model (e.g. `name` or
   * `title`), or 'id' if the model has no string field. */
  displayField?: string;
  /** the Domain (see CONTEXT.md) this model belongs to — groups it under a labeled section in the
   * console sidebar, alongside every other model in the same Domain. Set by codegen from the
   * model's folder location (`models/auth/*.model.ts` -> `'auth'`, ADR 0001), not meant to be
   * hand-authored here. */
  domain?: string;
}

export interface ApiModelOptions {
  /** excluded from the generic `/api/:model` router entirely (every verb 404s, same as an
   * unknown model name) — for a model whose only legitimate access path is a dedicated,
   * auth-scoped router. `console.hidden` alone doesn't do this: it only hides a model from the
   * console sidebar/`/meta/models`, the model stays reachable at `/api/:model` regardless. Set on
   * `Chat`/`Message` (src/automation/models): a `Message`'s real owner is indirect — whoever owns
   * its *parent* `Chat` — which the generic ownership mechanism (`ownerFieldOf`, direct column
   * equality on the row itself) can't express; only `Chat`/`Message`'s own
   * `/api/automation/chats/*` router (src/automation/router.ts) enforces that. `Agent`/`Role` stay
   * generic-REST-readable — their default `createdById` ownership is available like any model's,
   * just not restrictive enough on its own to replace a real permission grant for shared config
   * everyone with access needs to see. */
  hidden?: boolean;
  /** overrides which field counts as a row's owner — every model has one by default (the
   * auto-injected `createdById` system column, `core/pipeline.ts`'s `ownerFieldOf`), so this is
   * only needed when the real owner differs from whoever created the row (e.g. `Workspace`'s
   * `userId` — a self-registered user's default workspace is provisioned with no `ctx.user` at
   * all, so `createdById` would be null there). Every route (`create-router.ts`, and
   * `automation/tool.ts`'s agent-tool executor) enforces ownership automatically via
   * `core/pipeline.ts`'s `forceOwnerOnCreate`/`assertOwnsRow` once it resolves the caller's
   * `scope` for the action — a role's grant restricts this to `'own'` rows (the default when
   * unset) or opens it to `'any'` (`Role.permissions`, ratchet/auth); a model author never wires
   * an ownership check by hand. */
  ownerField?: string;
  /** opts this model out of the generic `/api/:model` router's implicit auth+permission gate
   * (every route on every model otherwise requires a matching role grant, including reads —
   * see `ratchet/auth`) — for a model that's genuinely meant to be reachable with no session at
   * all, e.g. a public read-only catalog. `true` applies to every verb; there's no per-operation
   * granularity today. Doesn't affect a model's own hand-rolled router (`api.hidden`), which was
   * never subject to this gate in the first place. */
  public?: boolean;
}

export interface ModelDefinition {
  /** also the table name and the REST route segment (§5 — no auto-pluralization) */
  name: string;
  tableName: string;
  /** one-line explanation of what a row of this model represents — surfaced in `/meta/models` for
   * the console, and prepended to the description of every `create_`/`update_`/`remove_` tool an
   * `Agent` is granted for this model (src/automation/tool.ts) so a chatting model has context
   * beyond the bare resource name. */
  description?: string;
  fields: Record<string, FieldDefinition>;
  operations: OperationsConfig;
  console?: ConsoleModelOptions;
  api?: ApiModelOptions;
}

export interface DefineModelConfig {
  description?: string;
  fields: Record<string, FieldDefinition>;
  operations?: {
    create?: PipelineFn;
    update?: PipelineFn;
    remove?: PipelineFn;
  } & Record<string, OperationEntry>;
  console?: ConsoleModelOptions;
  api?: ApiModelOptions;
}

function needsIdSuffix(f: FieldDefinition): f is ReferenceFieldDefinition | TreeFieldDefinition {
  return f.kind === 'reference' || f.kind === 'tree';
}

export function defineModel(name: string, config: DefineModelConfig): ModelDefinition {
  const fields: Record<string, FieldDefinition> = {};
  let treeFieldKey: string | undefined;

  for (const [key, f] of Object.entries(config.fields)) {
    // Q5: relation naming convention — the FK column key must end in 'Id' so `?include=`
    // can derive the relation name by stripping the suffix.
    if (needsIdSuffix(f) && !key.endsWith('Id')) {
      throw new Error(
        `model '${name}': ${f.kind} field '${key}' must have a key ending in 'Id' (e.g. '${f.kind === 'tree' ? 'parentId' : 'customerId'}'), got '${key}'`,
      );
    }
    // Self-referential manyToMany (targetModel === this model) is out of scope for now — the
    // junction's two FK columns are named `<modelName>Id` on each side (core/many-to-many.ts's
    // `junctionColumns`), which would collide when both sides are the same model.
    if (f.kind === 'manyToMany' && f.targetModel === name) {
      throw new Error(`model '${name}': self-referential field.manyToMany('${name}') on field '${key}' is not supported yet`);
    }
    // A self one-to-many is a hierarchy — `field.tree()` already covers that (core/field.ts's
    // `TreeFieldDefinition`), including cycle protection, so `referenceToMany` is parent→children
    // across two distinct models only.
    if (f.kind === 'referenceToMany' && f.targetModel === name) {
      throw new Error(`model '${name}': self-referential field.referenceToMany('${name}') on field '${key}' is not supported — use field.tree() for a self hierarchy`);
    }
    if (f.kind === 'tree') {
      // A model's hierarchy is a single tree — a second `field.tree()` would mean two independent
      // parent-pointer columns, and nothing downstream (console rendering, `core/tree.ts`'s cycle
      // check) is built to pick between them.
      if (treeFieldKey !== undefined) {
        throw new Error(
          `model '${name}': only one field.tree() is supported per model (found '${treeFieldKey}' and '${key}')`,
        );
      }
      treeFieldKey = key;
      // `field.tree()` can't know its own model's name yet (see `TreeFieldDefinition`'s doc
      // comment in core/field.ts) — this is the one place it's known, so it's filled in here,
      // same as every other model-level default this function already applies.
      fields[key] = { ...f, targetModel: name };
      continue;
    }
    fields[key] = f;
  }

  const operations: OperationsConfig = {
    // §3: if `operations` is omitted (or a verb within it is), the default pipeline applies.
    create: config.operations?.create ?? pipe(validate, persist),
    update: config.operations?.update ?? pipe(validate, persist),
    remove: config.operations?.remove ?? pipe(persist.remove),
  };

  // Any other key in `operations` is a custom operation (Q11/Q19) — merged in as-is so
  // `Object.keys(model.operations)` picks it up everywhere that already enumerates operation
  // names (console metadata, the `actionRef` field, `validateRolePermissions`).
  for (const [opName, entry] of Object.entries(config.operations ?? {})) {
    if (opName === 'create' || opName === 'update' || opName === 'remove') continue;
    if (RESERVED_OPERATION_NAMES.has(opName)) {
      throw new Error(`model '${name}': '${opName}' is a reserved operation name and can't be used for a custom operation`);
    }
    const def = typeof entry === 'function' ? undefined : entry;
    const placement = def?.console?.placement ?? ['row'];
    const hasParams = def?.params !== undefined && Object.keys(def.params).length > 0;
    if (placement.includes('bulk') && hasParams) {
      throw new Error(
        `model '${name}': custom operation '${opName}' can't combine placement 'bulk' with params — bulk-select only supports param-less operations (Q17)`,
      );
    }
    operations[opName] = entry as OperationEntry;
  }

  return { name, tableName: name, description: config.description, fields, operations, console: config.console, api: config.api };
}
