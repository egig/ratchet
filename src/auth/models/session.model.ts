import { defineModel, field } from '../../core/index.js';

/**
 * better-auth's `session` table (ADR 0005). Rows are created/destroyed by better-auth's own
 * `/api/auth/*` endpoints, never through generic REST — plain default `operations` (implicit
 * auth+permission, see `create-router.ts`) is enough to keep a stray `POST /api/sessions` from
 * being silently accepted, since no default role is granted the 'sessions' permission.
 */
export const Session = defineModel('sessions', {
  fields: {
    userId: field.reference('users', { required: true, indexed: true, displayText: 'User' }),
    token: field.string({ required: true, unique: true, indexed: true, maxLength: 255, sensitive: true }),
    expiresAt: field.datetime({ required: true, indexed: true }),
    ipAddress: field.string({ required: false, maxLength: 64 }),
    userAgent: field.text({ required: false }),
  },
  console: { hidden: true },
});
