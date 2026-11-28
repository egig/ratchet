import { defineModel, field, pipe, validate, persist } from '@egig/ratchet/core';
import { requireAuth, requirePermission } from '@egig/ratchet/auth';

/**
 * A conversation thread. Created/read/appended-to only through the dedicated
 * `/api/automation/chats/*` routes (src/automation/router.ts), which scope every read to the
 * requesting user — the generic `/api/:model` router has no row-level ownership check, only
 * `requirePermission`'s role/global grants, so `api: { hidden: true }` below excludes this model
 * from `/api/:model` entirely (every verb 404s, see `create-router.ts`'s `resolveModel`) rather
 * than relying on no role being granted the 'chats' permission. `operations` stay in place as a
 * safe default in case that flag is ever lifted.
 */
export const Chat = defineModel('chats', {
  fields: {
    userId: field.reference('users', { required: true, indexed: true, displayText: 'User' }),
    agentId: field.reference('agents', { required: true, indexed: true, displayText: 'Agent' }),
    title: field.string({ required: false, maxLength: 255 }),
    status: field.enum(['active', 'archived'], { default: 'active', indexed: true }),
  },
  operations: {
    create: pipe(requireAuth, requirePermission('chats', 'create'), validate, persist),
    update: pipe(requireAuth, requirePermission('chats', 'update'), validate, persist),
    remove: pipe(requireAuth, requirePermission('chats', 'remove'), persist.remove),
  },
  console: { hidden: true },
  api: { hidden: true },
});
