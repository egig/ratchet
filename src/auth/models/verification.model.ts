import { defineModel, field } from '../../core/index.js';

/** better-auth's `verification` table (ADR 0005): short-lived values for email verification,
 * password reset, OAuth state, and plugin flows. Managed only by better-auth. */
export const Verification = defineModel('verifications', {
  fields: {
    identifier: field.string({ required: true, indexed: true, maxLength: 255 }),
    value: field.text({ required: true, sensitive: true }),
    expiresAt: field.datetime({ required: true, indexed: true }),
  },
  console: { hidden: true },
});
