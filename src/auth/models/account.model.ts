import { defineModel, field } from '../../core/index.js';

/**
 * better-auth's `account` table (ADR 0005): one row per way a user can sign in. Email/password is
 * `providerId: 'credential'` with `password` holding the hash (src/auth/password.ts's format);
 * a social sign-in is `providerId: 'github'`/`'google'`/... with its OAuth tokens. Managed only by
 * better-auth's endpoints and `User`'s `setPassword` operation — hidden from the console, and every
 * secret column is `sensitive` so even a `*:*` role never reads one back through the API.
 */
export const Account = defineModel('accounts', {
  fields: {
    userId: field.reference('users', { required: true, indexed: true, displayText: 'User' }),
    accountId: field.string({ required: true, indexed: true, maxLength: 255 }),
    providerId: field.string({ required: true, indexed: true, maxLength: 64 }),
    password: field.text({ required: false, sensitive: true }),
    accessToken: field.text({ required: false, sensitive: true }),
    refreshToken: field.text({ required: false, sensitive: true }),
    idToken: field.text({ required: false, sensitive: true }),
    accessTokenExpiresAt: field.datetime({ required: false }),
    refreshTokenExpiresAt: field.datetime({ required: false }),
    scope: field.text({ required: false }),
  },
  console: { hidden: true },
});
