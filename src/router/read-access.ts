import type { AnyDb } from '../core/db.js';
import type { ReferenceFieldDefinition } from '../core/field.js';
import type { ModelDefinition } from '../core/model.js';
import { findRelationsTargeting } from '../core/many-to-many.js';
import { findRelationsTargeting as findReferenceToManyTargeting } from '../core/reference-to-many.js';
import { PipelineError } from '../core/pipeline.js';
import { resolveGrantedFields, pickGrantedFields, type GrantedFields } from '../auth/pipeline.js';
import type { FilterNode, ParsedListQuery } from './query.js';


/**
 * The read-time field-permission enforcement shared between the generic `/api/:model` GET routes
 * (`create-router.ts`) and the `list`/`findOne` agent tools (`automation/tool.ts`) — both read a
 * model exactly the same way (`router/list.ts`'s `listRows`/`getOneRow`) and must apply the same
 * `read` field grant to the result, including `?include=`d relations.
 */

/** Applies `pickGrantedFields` to every `?include=`d relation object already nested onto `row` by
 * `router/list.ts`'s `nestRow` — without this, embedding a related row via `?include=` would be a
 * clean bypass of that related resource's own field-read grants. Uses the same requesting role's
 * `read` grant for the *related* model, not the primary one; a role with no `read` access to that
 * resource at all degrades to an empty granted set (id/timestamps only), not an error — see
 * `resolveGrantedFields`'s "no matching row = nothing granted" default. */
export async function filterIncludedRelations(
  db: AnyDb,
  registry: Record<string, ModelDefinition>,
  model: ModelDefinition,
  row: Record<string, unknown>,
  includeNames: string[],
  roleId: string | null | undefined,
): Promise<void> {
  for (const name of includeNames) {
    const relValue = row[name];
    if (relValue === null || relValue === undefined) continue;

    if (Array.isArray(relValue)) {
      // a manyToMany or referenceToMany include (forward or reverse, router/list.ts's
      // attachManyToManyIncludes/attachReferenceToManyIncludes) — resolve its target model the same
      // way router/query.ts's parseInclude validated the name. Forward referenceToMany/manyToMany read
      // `targetModel` straight off the field; the reverse (source-model-name) case searches the
      // registry for a relation whose source is `name`.
      const forwardField = model.fields[name];
      const targetModelName =
        forwardField?.kind === 'manyToMany' || forwardField?.kind === 'referenceToMany'
          ? forwardField.targetModel
          : findRelationsTargeting(registry, model.name).find((r) => r.sourceModel.name === name)?.sourceModel.name ??
            findReferenceToManyTargeting(registry, model.name).find((r) => r.sourceModel.name === name)?.sourceModel.name;
      const targetModel = targetModelName ? registry[targetModelName] : undefined;
      if (!targetModel) continue;
      const granted = targetModel.api?.public ? ('*' as const) : await resolveGrantedFields(db, roleId, targetModel.name, 'read');
      row[name] = relValue.map((item) => pickGrantedFields(targetModel, item as Record<string, unknown>, granted));
      continue;
    }

    if (typeof relValue !== 'object') continue;
    const targetModel =
      name === 'createdBy' ? registry['users'] : registry[(model.fields[`${name}Id`] as ReferenceFieldDefinition).targetModel];
    if (!targetModel) continue;
    // A `public` target model has no role to check a grant against at all (same reasoning as
    // `resolveFieldAccess` for the primary resource) — everything is granted, independent of
    // whether the *primary* resource being listed/fetched is itself public.
    const granted = targetModel.api?.public ? ('*' as const) : await resolveGrantedFields(db, roleId, targetModel.name, 'read');
    row[name] = pickGrantedFields(targetModel, relValue as Record<string, unknown>, granted);
  }
}

function collectFilterFields(nodes: FilterNode[]): string[] {
  return nodes.flatMap((node) => ('logic' in node ? node.conditions.map((c) => c.field) : [node.field]));
}

/** Blocks `?filter=`/`?sort=` on a field the requester can't read — otherwise field-read denial
 * (`pickGrantedFields`) is trivial to bypass: binary-search a hidden value's range through
 * repeated filtered list calls even though it never appears in a response body. System columns
 * (not in `model.fields`) are exempt, same as everywhere else this framework gates fields. */
export function assertReadFieldsAllowed(model: ModelDefinition, query: ParsedListQuery, granted: GrantedFields): void {
  if (granted === '*') return;
  const requested = collectFilterFields(query.filters);
  for (const key of query.sort) requested.push(key.field);
  const fields: Record<string, string> = {};
  for (const key of requested) {
    if (key in model.fields && !granted.has(key)) fields[key] = 'field not permitted for your role';
  }
  if (Object.keys(fields).length > 0) throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
}
