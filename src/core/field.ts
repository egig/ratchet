import type { ZodTypeAny } from 'zod';

export interface FieldCommonOptions<T = unknown> {
  required?: boolean;
  default?: T;
  unique?: boolean;
  indexed?: boolean;
  /** stored, but stripped from every HTTP response — e.g. a password hash. */
  sensitive?: boolean;
  /** hide this field from the console list/table view while keeping it editable in the form. */
  hideInTable?: boolean;
  /** this field is written under a different, undeclared input key — e.g. `passwordHash`
   * declares `writeAs: 'password'` because a pipeline fn (`hashPassword`) synthesizes the real
   * column from a plaintext `password` key that never appears in `fields`. Read by console
   * metadata (src/console/serialize-model.ts) so a generated form knows which key to submit under. */
  writeAs?: string;
  /** human-readable label for the console list/form views; defaults to a humanized field key
   * (e.g. `roleId` -> "Role Id") when omitted. */
  displayText?: string;
  /** longer free-text help for this field — rendered as form help text in the console, and (more
   * importantly) emitted into the JSON Schema for agent tool parameters (`.describe()`, see
   * `core/validation.ts`) so a chatting model knows what a field means, not just its type. */
  description?: string;
}

interface BaseFieldDefinition {
  required: boolean;
  default?: unknown;
  unique: boolean;
  indexed: boolean;
  sensitive: boolean;
  hideInTable: boolean;
  writeAs?: string;
  displayText?: string;
  description?: string;
  /** set by `field.custom()` — a name the console client's `fieldRenderers` registry (see
   * `console/client/field-renderers.tsx`) can key a custom form editor off of. Storage and
   * validation are untouched: the field keeps its wrapped base kind's column type and Zod schema,
   * `customType` is metadata only, read by `console/serialize-model.ts`. */
  customType?: string;
}

export interface StringFieldDefinition extends BaseFieldDefinition {
  kind: 'string';
  maxLength?: number;
}

export interface TextFieldDefinition extends BaseFieldDefinition {
  kind: 'text';
}

export interface IntegerFieldDefinition extends BaseFieldDefinition {
  kind: 'integer';
}

export interface DecimalFieldDefinition extends BaseFieldDefinition {
  kind: 'decimal';
  precision: number;
  scale: number;
}

export interface BooleanFieldDefinition extends BaseFieldDefinition {
  kind: 'boolean';
}

export interface DatetimeFieldDefinition extends BaseFieldDefinition {
  kind: 'datetime';
}

export interface EnumFieldDefinition extends BaseFieldDefinition {
  kind: 'enum';
  values: readonly string[];
}

export interface JsonFieldDefinition extends BaseFieldDefinition {
  kind: 'json';
  schema?: ZodTypeAny;
}

export interface ReferenceFieldDefinition extends BaseFieldDefinition {
  kind: 'reference';
  targetModel: string;
}

/** Names a model itself (e.g. `'users'`), not a row within one — unlike `ReferenceFieldDefinition`
 * there's no fixed `targetModel`: any model in the app's registry is a valid value. Validation
 * against the live registry happens at request time (see `ratchet/auth`'s `validatePermissionTarget`),
 * not here — `baseSchemaForField` treats it as a plain string, since no registry exists yet when a
 * model file's static field definitions are evaluated. `allowWildcard` is UI-only metadata (see
 * `ConsoleFieldMeta`/`fields.tsx`): it doesn't loosen validation, it just tells the console form
 * whether to offer a `*` option alongside real model names. */
export interface ModelRefFieldDefinition extends BaseFieldDefinition {
  kind: 'modelRef';
  allowWildcard: boolean;
}

/** Names an *operation* (e.g. `'create'`) rather than declaring a fixed set of them — the real
 * set is whichever operation names actually exist across the app's models, read from the live
 * registry at request time (see `ratchet/auth`'s `validatePermissionTarget`), the same way
 * `ModelRefFieldDefinition` reads model names. `allowWildcard` mirrors `ModelRefFieldDefinition`'s. */
export interface ActionRefFieldDefinition extends BaseFieldDefinition {
  kind: 'actionRef';
  allowWildcard: boolean;
}

/** Names a *field* on whichever model a sibling `modelRef` value points at (e.g. `Role.permissions`'
 * `field` key names a field on the model its own `resource` key points at) — validated
 * against the live registry at request time (see `ratchet/auth`'s `validatePermissionTarget`),
 * the same way `ModelRefFieldDefinition`/`ActionRefFieldDefinition` are. `allowWildcard` mirrors
 * theirs: it lets `'*'` stand for "every field." Unlike `resource`/`action`, requiredness isn't a
 * static per-field setting here — whether a given row even needs a `field` value depends on that
 * row's own `action` (e.g. `remove` has no field-shaped meaning at all), so `validatePermissionTarget`
 * enforces that conditionally rather than `field.ts` declaring `required: true`. */
export interface FieldRefFieldDefinition extends BaseFieldDefinition {
  kind: 'fieldRef';
  allowWildcard: boolean;
}

/** Declares a many-to-many relation to `targetModel` — backed by an auto-generated junction model
 * (see `core/many-to-many.ts`), never a real column on this model's own table. Extends
 * `BaseFieldDefinition` only so every field kind shares one shape for code that reads across the
 * `FieldDefinition` union unconditionally (e.g. `console/serialize-model.ts`'s `serializeField`) —
 * `required`/`default`/`unique`/`indexed`/`sensitive` are all meaningless here (there's no column
 * to require, default, index, or hide) and `field.manyToMany()` below never lets a caller set them;
 * `base()` just fills them with its normal false/undefined defaults. Relation filtering goes
 * through a dedicated `has` operator instead of `indexed` (see `router/fields.ts`), and the
 * relation is already invisible unless explicitly `?include=`d, so there's nothing for `sensitive`
 * to hide. Declared once, on either side — `?include=` and `has`-filtering both work from the
 * *other* model too, with no matching declaration needed there (see `core/many-to-many.ts`'s
 * `findRelationsTargeting`). */
export interface ManyToManyFieldDefinition extends BaseFieldDefinition {
  kind: 'manyToMany';
  targetModel: string;
}

/** A normalized one-to-many relation: the *target* model physically stores a foreign key back to the
 * declaring ("one") model, so each target row belongs to exactly one parent — the real relational
 * one-to-many guarantee (a `manyToMany` junction or a `referenceToMany` array column can't enforce
 * that). Unlike `manyToMany` (a synthetic junction table) or a `referenceToMany` stored as an array
 * on the parent, storage is a single FK column on the target (`<declaringModelName>Id` by default,
 * or `inverseColumn` when set — see `core/reference-to-many.ts`'s `inverseColumnName`), generated
 * by codegen and surfaced on the target as a normal `reference` field. The only authored surface is
 * the `referenceToMany` declaration on the parent; its console form (a multi-select, reusing
 * `manyToMany`'s `<ManyToManyMultiSelect>`) is where the children are chosen, and writes sync the
 * target rows' FK through `core/pipeline.ts`'s `syncReferenceToManyFields`. `required`/`default`/
 * `unique`/`indexed` are meaningless here (there's no column on this model), so `field.referenceToMany()`
 * never lets a caller set them, the same way `field.manyToMany()` doesn't. Self-reference is rejected
 * by `defineModel` (see `core/model.ts`) — a self one-to-many is a `tree`, which already exists. */
export interface ReferenceToManyFieldDefinition extends BaseFieldDefinition {
  kind: 'referenceToMany';
  targetModel: string;
  /** overrides the auto-derived inverse FK column name (`<declaringModelName>Id`) on `targetModel`.
   * Only needed when the target already has, or needs, a differently-named FK for this relation —
   * e.g. two relations to the same target, or matching an explicitly-declared `reference` field. */
  inverseColumn?: string;
}

/** A parent-pointer hierarchy on this model itself — e.g. a `Category` or Chart-of-Accounts
 * `Account` whose `parentId` points at another row of the *same* model, forming a tree (root nodes
 * carry a `null` parent). Structurally identical to a self-referencing `ReferenceFieldDefinition`
 * (nullable uuid FK, `onDelete: 'restrict'` — see `codegen/schema-gen.ts`), but kept as its own
 * `kind` rather than `field.reference(ownModelName)` so the console can render it as a tree picker
 * instead of a flat dropdown, and so writes get cycle protection for free (see
 * `core/tree.ts`'s `wouldCreateTreeCycle`, run by `persistWrite` in `core/pipeline.ts`) — a plain
 * `reference` field has no such guard and shouldn't need one. `targetModel` is always the
 * declaring model's own name; `field.tree()` can't know that at declaration time (the model isn't
 * built yet), so it's left `''` here and filled in by `defineModel()` (core/model.ts), the same
 * place a `field.tree()` field's key is checked for the `'Id'` suffix and a model is checked for
 * declaring at most one. */
export interface TreeFieldDefinition extends BaseFieldDefinition {
  kind: 'tree';
  targetModel: string;
}

/** Stores a reference to a blob held by a `FileStorage` (see `core/storage.ts`), not the
 * bytes themselves — the column is `{ key, filename, mimeType, size }` (jsonb). `accept` is a
 * comma-separated list of mime patterns (`'image/png'`, `'image/*'`) checked against the
 * *sniffed* bytes of an upload, never the client-declared Content-Type — a mislabeled upload
 * would otherwise bypass it. `preview: 'image'` is what turns on thumbnail rendering in the
 * console (list + form) and — when `accept` is omitted — defaults `accept` to `'image/*'` so the
 * common case is just `field.file({ preview: 'image' })`. `maxSize` (bytes) overrides
 * `DEFAULT_MAX_FILE_SIZE` (core/storage.ts) for this field only. */
export interface FileFieldDefinition extends BaseFieldDefinition {
  kind: 'file';
  accept?: string;
  preview?: 'image';
  maxSize?: number;
  /** only meaningful on a Domain Settings field (a model's `file` field has no equivalent — its
   * read route is always gated by that model's own `read` permission, see
   * `router/create-router.ts`'s `GET /:model/:id/:field`). `true` serves this field's current
   * value with no auth at all, from a fixed, content-addressed URL — `GET
   * /_site-assets/:domain/:field/:token` (`router/site-assets.ts`) — for a value meant to be
   * embedded in a public page (a site favicon, a social share image, ...), which browsers and
   * social-media crawlers alike fetch with no session. Defaults `false`: a Domain Settings `file`
   * field with no dedicated read route at all yet, same as before this option existed. */
  public?: boolean;
}

export type FieldDefinition =
  | StringFieldDefinition
  | TextFieldDefinition
  | IntegerFieldDefinition
  | DecimalFieldDefinition
  | BooleanFieldDefinition
  | DatetimeFieldDefinition
  | EnumFieldDefinition
  | JsonFieldDefinition
  | ReferenceFieldDefinition
  | ModelRefFieldDefinition
  | ActionRefFieldDefinition
  | FieldRefFieldDefinition
  | FileFieldDefinition
  | ManyToManyFieldDefinition
  | ReferenceToManyFieldDefinition
  | TreeFieldDefinition;

function assertNoRequiredDefaultConflict(opts: FieldCommonOptions): void {
  if (opts.required && opts.default !== undefined) {
    throw new Error(
      "field declares both 'required: true' and a 'default' — a field with a default is never absent, so 'required' is contradictory. Remove one.",
    );
  }
}

function base(opts: FieldCommonOptions): BaseFieldDefinition {
  assertNoRequiredDefaultConflict(opts);
  return {
    required: opts.required ?? false,
    default: opts.default,
    unique: opts.unique ?? false,
    indexed: opts.indexed ?? false,
    sensitive: opts.sensitive ?? false,
    hideInTable: opts.hideInTable ?? false,
    writeAs: opts.writeAs,
    displayText: opts.displayText,
    description: opts.description,
  };
}

export const field = {
  string(opts: { maxLength?: number } & FieldCommonOptions<string> = {}): StringFieldDefinition {
    return { ...base(opts), kind: 'string', maxLength: opts.maxLength };
  },

  text(opts: FieldCommonOptions<string> = {}): TextFieldDefinition {
    return { ...base(opts), kind: 'text', hideInTable: opts.hideInTable ?? true };
  },

  integer(opts: FieldCommonOptions<number> = {}): IntegerFieldDefinition {
    return { ...base(opts), kind: 'integer' };
  },

  decimal(opts: { precision: number; scale: number } & FieldCommonOptions<string>): DecimalFieldDefinition {
    return { ...base(opts), kind: 'decimal', precision: opts.precision, scale: opts.scale };
  },

  boolean(opts: FieldCommonOptions<boolean> = {}): BooleanFieldDefinition {
    return { ...base(opts), kind: 'boolean' };
  },

  datetime(opts: FieldCommonOptions<Date | string> = {}): DatetimeFieldDefinition {
    return { ...base(opts), kind: 'datetime' };
  },

  enum<const T extends readonly string[]>(
    values: T,
    opts: FieldCommonOptions<T[number]> = {},
  ): EnumFieldDefinition {
    if (values.length === 0) {
      throw new Error('field.enum() requires at least one value');
    }
    return { ...base(opts), kind: 'enum', values };
  },

  json(opts: { schema?: ZodTypeAny } & FieldCommonOptions = {}): JsonFieldDefinition {
    return { ...base(opts), kind: 'json', schema: opts.schema, hideInTable: opts.hideInTable ?? true };
  },

  reference(targetModel: string, opts: FieldCommonOptions<string> = {}): ReferenceFieldDefinition {
    return { ...base(opts), kind: 'reference', targetModel, hideInTable: opts.hideInTable ?? true };
  },

  modelRef(opts: { allowWildcard?: boolean } & FieldCommonOptions<string> = {}): ModelRefFieldDefinition {
    return { ...base(opts), kind: 'modelRef', allowWildcard: opts.allowWildcard ?? false };
  },

  actionRef(opts: { allowWildcard?: boolean } & FieldCommonOptions<string> = {}): ActionRefFieldDefinition {
    return { ...base(opts), kind: 'actionRef', allowWildcard: opts.allowWildcard ?? false };
  },

  fieldRef(opts: { allowWildcard?: boolean } & FieldCommonOptions<string> = {}): FieldRefFieldDefinition {
    return { ...base(opts), kind: 'fieldRef', allowWildcard: opts.allowWildcard ?? false };
  },

  file(
    opts: { accept?: string; preview?: 'image'; maxSize?: number; public?: boolean } & FieldCommonOptions = {},
  ): FileFieldDefinition {
    return {
      ...base(opts),
      kind: 'file',
      accept: opts.accept ?? (opts.preview === 'image' ? 'image/*' : undefined),
      preview: opts.preview,
      maxSize: opts.maxSize,
      public: opts.public ?? false,
      hideInTable: opts.hideInTable ?? true
    };
  },

  manyToMany(targetModel: string, opts: { displayText?: string; description?: string; hideInTable?: boolean } = {}): ManyToManyFieldDefinition {
    return { ...base(opts), kind: 'manyToMany', targetModel, hideInTable: opts.hideInTable ?? true };
  },

  referenceToMany(
    targetModel: string,
    opts: { displayText?: string; description?: string; inverseColumn?: string; hideInTable?: boolean } = {},
  ): ReferenceToManyFieldDefinition {
    return { ...base(opts), kind: 'referenceToMany', targetModel, inverseColumn: opts.inverseColumn, hideInTable: opts.hideInTable ?? true };
  },

  /** Never `required` (a root node has no parent — there's nothing to require) and never `unique`
   * (many children legitimately share one parent), so `opts` is narrowed to just `indexed`/
   * `displayText`, the same way `manyToMany()`'s is. `targetModel` is a placeholder here — see
   * `TreeFieldDefinition`'s doc comment for why `defineModel()` has to fill in the real value. */
  tree(opts: { indexed?: boolean; displayText?: string; description?: string, hideInTable?: boolean } = {}): TreeFieldDefinition {
    return { ...base(opts), kind: 'tree', targetModel: '', hideInTable: opts.hideInTable ?? true };
  },

  /** Tags an existing field definition with a `name` the console client can key a custom form
   * editor off of (see `console/client/field-renderers.tsx`), without introducing a new storage
   * kind — `base`'s DB column and Zod validation apply unchanged, e.g.
   * `field.custom('html', field.text())` stores and validates exactly like `field.text()`, it
   * just renders differently in the console. */
  custom<F extends FieldDefinition>(name: string, base: F, opts: { hideInTable?: boolean } = {}): F {
    return { ...base, customType: name, hideInTable: opts.hideInTable ?? true };
  },
};
