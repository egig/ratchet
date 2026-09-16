import { z, type ZodTypeAny } from 'zod';
import type { FieldDefinition } from './field.js';
import type { ModelDefinition } from './model.js';
import type { DomainDefinition } from './domain.js';

/** The Zod schema for a field's *value*, before optionality (`fieldToZod`) or a field's
 * `description` (`baseSchemaForField`) is applied. */
function schemaForFieldKind(f: FieldDefinition): ZodTypeAny {
  switch (f.kind) {
    case 'string':
      return f.maxLength !== undefined ? z.string().max(f.maxLength) : z.string();
    case 'text':
      return z.string();
    case 'integer':
      return z.number().int();
    case 'decimal':
      // Q24: decimals round-trip as numeric strings, never JS `number`, to preserve precision.
      return z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string, e.g. "129.99"');
    case 'boolean':
      return z.boolean();
    case 'datetime':
      return z.union([z.string(), z.date()]);
    case 'enum':
      return z.enum(f.values as [string, ...string[]]);
    case 'json':
      // Q14: an explicit, narrow exception — a user-supplied live Zod schema is referenced
      // directly rather than re-derived, since arbitrary Zod schemas can't be reconstructed here.
      return f.schema ?? z.record(z.string(), z.unknown());
    case 'reference':
      return z.string().uuid();
    case 'tree':
      // like 'reference', but `.nullable()` too — re-parenting a node to the root is a normal,
      // needed write (`null` means "no parent"), unlike a plain `reference` field, which is
      // never expected to be cleared back to "nothing" once set.
      return z.string().uuid().nullable();
    case 'modelRef':
    case 'actionRef':
    case 'fieldRef':
      // intentionally not checked against the registry here — no live registry exists when a
      // model's static field definitions are built. The real check is
      // `validateRolePermissions` (ratchet/auth), which runs per-request against `ctx.registry`.
      return z.string();
    case 'file':
      // the shape returned by the upload endpoint (see `router/create-router.ts`) and stored
      // as-is in the jsonb column — accept/maxSize/mime-sniffing are enforced at upload time,
      // not re-validated here.
      return z.object({
        key: z.string(),
        filename: z.string(),
        mimeType: z.string(),
        size: z.number().int().nonnegative(),
      });
    case 'manyToMany':
      // the full desired set of target-row ids, diffed against current junction rows by
      // `persistWrite` (core/pipeline.ts) — never a partial patch. Always optional regardless of
      // `f.required` (see `fieldToZod`/`buildUpdateSchema` below): omitting the key entirely means
      // "leave this relation alone," matching how every other optional field behaves on update.
      return z.array(z.string().uuid());
    case 'referenceToMany':
      // the full desired set of target-row ids, diffed against the target's inverse FK column by
      // `syncReferenceToManyFields` (core/pipeline.ts) — never a partial patch. Always optional, same
      // as manyToMany: omitting the key means "leave this relation alone," and a target id appearing
      // in two parents' lists would be a data error only if the FK were unique, which it isn't.
      return z.array(z.string().uuid());
  }
}

/** `schemaForFieldKind` plus the field's own `description` (`.describe()` — carried through to the
 * JSON Schema `zod-to-json-schema` emits for agent tool params, and shown as console form help). */
function baseSchemaForField(f: FieldDefinition): ZodTypeAny {
  const schema = schemaForFieldKind(f);
  return f.description ? schema.describe(f.description) : schema;
}

function fieldToZod(f: FieldDefinition): ZodTypeAny {
  const schema = baseSchemaForField(f);
  // Q13: a field with `default` is never required (field.ts already rejects required+default
  // together), so `required` is the only signal needed to decide optionality here — except
  // manyToMany, which is never required (`field.manyToMany()` never sets it) but is spelled out
  // for clarity anyway, since a model author can't accidentally make one required.
  // Q13: manyToMany/referenceToMany are never required (`field.manyToMany()`/`field.referenceToMany()`
  // never set it) but are spelled out for clarity anyway, since a model author can't accidentally make
  // one required — they're always optional so omitting the key means "leave this relation alone."
  return f.required && f.kind !== 'manyToMany' && f.kind !== 'referenceToMany' ? schema : schema.optional();
}

export function buildCreateSchema(model: ModelDefinition): ZodTypeAny {
  return buildFieldsSchema(model.fields);
}

function buildFieldsSchema(fields: Record<string, FieldDefinition>): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, f] of Object.entries(fields)) {
    shape[key] = fieldToZod(f);
  }
  return z.object(shape);
}

/** A custom operation's `params` (core/model.ts's `CustomOperationDefinition`) are declared with
 * the same `field.*()` builder DSL as model fields, so validating a call's request body is exactly
 * `buildCreateSchema` scoped to that param map instead of the model's own fields — every param is
 * required/optional per its own `required` flag, same as create. */
export function buildParamsSchema(params: Record<string, FieldDefinition>): ZodTypeAny {
  return buildFieldsSchema(params);
}

export function buildUpdateSchema(model: ModelDefinition): ZodTypeAny {
  // Q2: update is PATCH-shaped — every field is optional, regardless of `required`.
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, f] of Object.entries(model.fields)) {
    shape[key] = baseSchemaForField(f).optional();
  }
  return z.object(shape);
}

/** Domain Settings are always patch-shaped (ADR 0002) — there's no create, only ever an update
 * against the one row a Domain has — so every field is optional here regardless of `required`,
 * same as `buildUpdateSchema`. */
export function buildDomainSettingsSchema(def: DomainDefinition): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, f] of Object.entries(def.settingFields ?? {})) {
    shape[key] = baseSchemaForField(f).optional();
  }
  return z.object(shape);
}
