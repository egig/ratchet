import { defineModel, field, pipe, validate, persist } from '../../core/index.js';
import { createDefaultWorkspace } from '../../workspace/provisioning.js';
import { setPassword } from '../pipeline.js';

/**
 * better-auth's `user` table (ADR 0005). `name`/`email`/`emailVerified`/`image` are better-auth's
 * own core columns; `roleId`/`active` are Ratchet's, declared to better-auth as
 * `user.additionalFields` with `input: false` (src/auth/better-auth.ts) so `/sign-up/email` and
 * `/update-user` can never set them. There is no password column: a password is a `credential`
 * row in `accounts` (account.model.ts), which is where better-auth reads it from.
 */
export const User = defineModel('users', {
  fields: {
    email: field.string({ required: true, unique: true, indexed: true, maxLength: 320 }),
    // Required by better-auth's schema, but Ratchet's own create paths (console, `/setup`,
    // `ratchet create-admin`) don't ask for one — better-auth writes '' when a client omits it.
    name: field.string({ required: false, maxLength: 200 }),
    emailVerified: field.boolean({ default: false, displayText: 'Email verified' }),
    image: field.string({ required: false, maxLength: 2048 }),
    roleId: field.reference('roles', { required: false, indexed: true, displayText: 'Role' }),
    active: field.boolean({ default: true }),
  },
  operations: {
    // admin-driven creation via generic `POST /api/users` — implicitly gated like any other model
    // (see create-router.ts). Self-signup goes through better-auth's `/api/auth/sign-up/email`
    // instead, which provisions the same default workspace from a `databaseHooks.user.create`
    // hook (src/auth/better-auth.ts).
    create: pipe(validate, persist, createDefaultWorkspace),
    setPassword: {
      pipeline: setPassword,
      description: "Set this user's sign-in password (creates their email/password credential if they have none).",
      params: {
        password: field.string({ required: true, sensitive: true, writeAs: 'password', maxLength: 128, displayText: 'New password' }),
      },
      console: { label: 'Set password' },
    },
  },
});
