import { z } from 'zod';
import { defineModel, field, pipe, validate, persist } from '../../core/index.js';
import { requireValidPermissions } from '../pipeline.js';

// a bare `field.json()` defaults to an object schema (z.record) — `permissions` is an array, so
// it needs its own explicit shape (core/validation.ts's `baseSchemaForField` can't infer one).
// One entry names a single grant: `resource`/`action` may each independently be `'*'`; `field` is
// required for a field-shaped action (`read`/`create`/`update`/`*`) and forbidden for `remove` or
// a custom operation — a cross-field rule `validatePermissionTarget` (ratchet/auth) enforces
// against the live registry at request time, not this schema.
const permissionTargetSchema = z.object({
  resource: z.string(),
  action: z.string(),
  field: z.string().nullable().optional(),
});

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
    // The role's entire grant list — one JSON column instead of a `Permission` junction table
    // (docs/guide/auth.md). NOT `required: true` — `field.ts`'s `assertNoRequiredDefaultConflict`
    // forbids `required` + `default` together, and a `default: []` column is never absent; every
    // consumer already treats a missing/empty array as "no grants" (secure-by-default). Edited via
    // a plain `PATCH /api/roles/:id` — see `role.form.tsx`'s tree UI — not a custom operation.
    permissions: field.json({ schema: z.array(permissionTargetSchema), default: [] }),
  },
  operations: {
    create: pipe(validate, requireValidPermissions, persist),
    update: pipe(validate, requireValidPermissions, persist),
  },
  console: {},
});
