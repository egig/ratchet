import type { ModelDefinition, OperationVisibilityRule } from '../core/model.js';
import { ownerFieldOf } from '../core/pipeline.js';

export interface ConsoleFieldMeta {
  key: string;
  /** human-readable label for list-view column headers and form field labels — the field's
   * `displayText` if declared, otherwise the key humanized (e.g. `roleId` -> "Role Id"). */
  label: string;
  /** the field's `description` (core/field.ts), when declared — rendered as form help text. */
  description?: string;
  kind: string;
  required: boolean;
  unique: boolean;
  indexed: boolean;
  sensitive: boolean;
  /** when true, the field is omitted from the console list/table columns but still shown in forms. */
  hideInTable: boolean;
  default?: unknown;
  /** present only on a sensitive field that's writable under a different key — e.g.
   * `passwordHash` (sensitive, never read back) reports `writeAs: 'password'`. */
  writeAs?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  values?: readonly string[];
  targetModel?: string;
  allowWildcard?: boolean;
  accept?: string;
  preview?: 'image';
  maxSize?: number;
  /** `field.file({ public: true })` — this field's current value is served with no auth from a
   * fixed URL (Domain Settings only; see `core/serialize.ts`'s `siteAssetUrl`, applied server-side
   * to the value itself before it ever reaches the client, so the console never needs to build
   * this URL by hand). Metadata only — informational for now, e.g. a future "public" hint in the
   * form. */
  public?: boolean;
  /** set when the field was declared with `field.custom(name, base)` — see `core/field.ts`. Keys
   * the console client's `fieldRenderers` registry (`console/client/field-renderers.tsx`) so a
   * consumer app can swap in a custom form editor for this field, e.g. a rich-text editor for an
   * otherwise plain `text` field. */
  customType?: string;
}

/** `ConsoleOperationMeta.placement`'s options — where a custom operation's button/predicate is
 * offered in the console. Mirrors `OperationConsoleOptions.placement` (core/model.ts). */
export type ConsoleOperationPlacement = 'row' | 'detail' | 'bulk';

export interface ConsoleOperationMeta {
  name: string;
  label: string;
  /** the operation's `description` (core/model.ts's `CustomOperationDefinition`), when declared. */
  description?: string;
  /** the operation's input params, serialized the same way a model's own fields are — empty for a
   * param-less trigger (e.g. `lock`). Non-empty means the console renders a small modal form built
   * from these before calling the operation, instead of firing immediately. */
  params: ConsoleFieldMeta[];
  /** `true` for a generic confirm, a string for a custom confirm message, absent for none. */
  confirm?: string | true;
  placement: ConsoleOperationPlacement[];
  visibleWhen?: OperationVisibilityRule;
}

export interface ConsoleModelMeta {
  name: string;
  label: string;
  /** the model's `description` (core/model.ts), when declared. */
  description?: string;
  displayField: string;
  fields: ConsoleFieldMeta[];
  /** this model's real operation names (`Object.keys(model.operations)`) — read by an `actionRef`
   * field's dropdown so it lists actual operations, builtin and custom alike, instead of a
   * hardcoded set (see `console/client/fields.tsx`). */
  operationNames: string[];
  /** every operation beyond the three builtins (`create`/`update`/`remove` are never included
   * here — they get their own dedicated Edit/Delete UI) — read by `RowTable`/`ModelFormPage` to
   * render a button per custom operation (see `console/client/OperationButton.tsx`). */
  operations: ConsoleOperationMeta[];
  /** this model's Domain (see CONTEXT.md), when it has one — the console sidebar
   * (`console/client/Layout.tsx`) groups models sharing a `domain` under one labeled section. */
  domain?: string;
  /** the column that counts as a row's owner for this model (`core/pipeline.ts`'s `ownerFieldOf`)
   * — `ApiModelOptions.ownerField` when set, else the default `'createdById'`. Every model has
   * one; `role.form.tsx`'s permission tree uses it to label the own/any scope control it renders
   * for every resource+action node. */
  ownerField: string;
}

const BUILTIN_OPERATION_NAMES: ReadonlySet<string> = new Set(['create', 'update', 'remove']);

function serializeOperation(model: ModelDefinition, name: string): ConsoleOperationMeta {
  const entry = model.operations[name];
  const def = typeof entry === 'function' ? undefined : entry;
  const console_ = def?.console;
  return {
    name,
    label: console_?.label ?? humanize(name),
    ...(def?.description ? { description: def.description } : {}),
    params: Object.entries(def?.params ?? {}).map(([key, f]) => serializeField(key, f)),
    confirm: console_?.confirm === false ? undefined : console_?.confirm,
    placement: [...(console_?.placement ?? ['row'])],
    visibleWhen: console_?.visibleWhen,
  };
}

export function humanize(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Splits a camelCase field key into words and capitalizes the first letter of each — e.g.
 * `roleId` -> "Role Id", `passwordHash` -> "Password Hash". */
function humanizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

export function serializeField(key: string, f: ModelDefinition['fields'][string]): ConsoleFieldMeta {
  const meta: ConsoleFieldMeta = {
    key,
    label: f.displayText ?? humanizeFieldKey(key),
    kind: f.kind,
    ...(f.description ? { description: f.description } : {}),
    required: f.required,
    unique: f.unique,
    indexed: f.indexed,
    sensitive: f.sensitive,
    hideInTable: f.hideInTable,
  };
  if (f.default !== undefined) meta.default = f.default;
  if (f.writeAs) meta.writeAs = f.writeAs;
  if (f.customType) meta.customType = f.customType;
  if (f.kind === 'string') meta.maxLength = f.maxLength;
  if (f.kind === 'decimal') {
    meta.precision = f.precision;
    meta.scale = f.scale;
  }
  if (f.kind === 'enum') meta.values = f.values;
  if (f.kind === 'reference' || f.kind === 'manyToMany' || f.kind === 'referenceToMany' || f.kind === 'tree') meta.targetModel = f.targetModel;
  if (f.kind === 'modelRef' || f.kind === 'actionRef' || f.kind === 'fieldRef') meta.allowWildcard = f.allowWildcard;
  if (f.kind === 'file') {
    meta.accept = f.accept;
    meta.preview = f.preview;
    meta.maxSize = f.maxSize;
    meta.public = f.public;
  }
  return meta;
}

/** Picks a fallback `displayField` when the model didn't declare one: the first `string`-kind
 * field in declaration order (typically something like `name` or `title`), or `id` if the model
 * has no string field. */
function inferDisplayField(model: ModelDefinition): string {
  const firstStringField = Object.entries(model.fields).find(([, f]) => f.kind === 'string');
  return firstStringField?.[0] ?? 'id';
}

/** Strips the parts of a `ModelDefinition` that either can't cross the wire (the `operations`
 * pipeline fns, a `json` field's Zod schema) or shouldn't (nothing here reveals more than the
 * declared field shape) — served by `GET /meta/models[/:name]` for the console SPA's sidebar
 * and dynamically-generated list/form views. */
export function serializeModelMeta(model: ModelDefinition): ConsoleModelMeta {
  const meta: ConsoleModelMeta = {
    name: model.name,
    label: model.console?.label ?? humanize(model.name),
    ...(model.description ? { description: model.description } : {}),
    displayField: model.console?.displayField ?? inferDisplayField(model),
    fields: Object.entries(model.fields).map(([key, f]) => serializeField(key, f)),
    operationNames: Object.keys(model.operations),
    operations: Object.keys(model.operations)
      .filter((name) => !BUILTIN_OPERATION_NAMES.has(name))
      .map((name) => serializeOperation(model, name)),
    ownerField: ownerFieldOf(model),
  };
  if (model.console?.domain) meta.domain = model.console.domain;
  return meta;
}
