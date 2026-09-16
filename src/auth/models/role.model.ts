import { z } from 'zod';
import { defineModel, field, pipe, validate, persist } from '../../core/index.js';
import { requireValidPermissions } from '../pipeline.js';

// `permissions` is a tree, `resource -> action -> grant` — either key may be `'*'`. `fields` is
// required for a field-shaped action (`read`/`create`/`update`/`'*'`) and forbidden for `remove`
// or a custom operation; `scope` only makes sense on a resource whose model declares
// `api.ownerField`; sibling keys at either level can't mix `'*'` with specific keys — a
// cross-field rule `validateRolePermissions` (ratchet/auth) enforces all of this against the live
// registry at request time, not this schema.
const actionGrantSchema = z.object({
  fields: z.union([z.literal('*'), z.array(z.string())]).optional(),
  scope: z.enum(['own', 'any']).optional(),
});
const permissionsSchema = z.record(z.string(), z.record(z.string(), actionGrantSchema));

export const Role = defineModel('roles', {
  fields: {
    name: field.string({ required: true, unique: true, indexed: true, maxLength: 100 }),
    description: field.text({ required: false }),
    // The `Workspace` (workspace/models/workspace.model.ts) a new `User` assigned this role is
    // provisioned from — its `WorkspaceView` tabs get cloned onto the user's own workspace by
    // `workspace/provisioning.ts`'s `createDefaultWorkspace`. Optional: a role that exists purely
    // for permissions (e.g. an API-only role) doesn't need one, and `createDefaultWorkspace` falls
    // back to a blank workspace when it's unset.
    workspaceTemplateId: field.reference('workspaces', {
      required: false,
      indexed: true,
      displayText: 'Default Workspace',
    }),
    // The role's entire grant tree — one JSON column instead of a `Permission` junction table
    // (docs/content/docs/auth.mdx). NOT `required: true` — `field.ts`'s
    // `assertNoRequiredDefaultConflict` forbids `required` + `default` together, and a
    // `default: {}` column is never absent; every consumer already treats a missing/empty object
    // as "no grants" (secure-by-default). Edited via a plain `PATCH /api/roles/:id` — see
    // `role.form.tsx`'s tree UI — not a custom operation.
    permissions: field.json({ schema: permissionsSchema, default: {} }),
  },
  operations: {
    create: pipe(validate, requireValidPermissions, persist),
    update: pipe(validate, requireValidPermissions, persist),
  },
  console: {},
});
