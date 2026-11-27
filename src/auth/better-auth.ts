import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import type { AnyDb } from '../core/db.js';
import { generateId } from '../core/id.js';
import { createDefaultWorkspace } from '../workspace/provisioning.js';
import { ratchetAdapter } from './adapter.js';
import { COOKIE_PREFIX } from './cookie.js';
import { findUserById } from './lookup.js';
import { User } from './models/user.model.js';
import { hashPassword, verifyPassword } from './password.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './pipeline.js';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * `FrameworkConfig.auth` — better-auth's own options, passed through. Use it for what better-auth
 * provides: `socialProviders` (GitHub, Google, ...), `emailVerification`/`sendResetPassword`
 * callbacks, `session` lifetimes, `rateLimit`, `trustedOrigins`, extra `plugins`.
 *
 * Ratchet owns the parts its own code depends on, and those win over anything set here: the
 * database adapter, `basePath` (`/api/auth`), the cookie prefix (`ratchet`, read by
 * `resolveSessionToken`), uuidv7 ids, the PBKDF2 password hasher, the `roleId`/`active` user
 * fields, and the `bearer` plugin. `databaseHooks.user.create.after` and
 * `databaseHooks.session.create.before` run after Ratchet's own hooks for the same events.
 *
 * A plugin that adds tables (two-factor, organization, ...) needs a matching model under
 * `models/` so `ratchet generate` migrates them — see docs/content/docs/auth.mdx.
 */
export type AuthConfig = Omit<BetterAuthOptions, 'database' | 'basePath'>;

export function createRatchetAuth(db: AnyDb, config: AuthConfig = {}) {
  const userHooks = config.databaseHooks?.user;
  const sessionHooks = config.databaseHooks?.session;

  const options = {
    ...config,
    telemetry: { enabled: false, ...config.telemetry },
    database: ratchetAdapter(db),
    basePath: AUTH_BASE_PATH,
    advanced: {
      ...config.advanced,
      cookiePrefix: COOKIE_PREFIX,
      database: { ...config.advanced?.database, generateId: () => generateId() },
    },
    emailAndPassword: {
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      ...config.emailAndPassword,
      enabled: config.emailAndPassword?.enabled ?? true,
      // Ratchet's Web Crypto PBKDF2 (src/auth/password.ts), not better-auth's scrypt default: hashes
      // written before better-auth stay valid, and it runs unchanged on Node, Bun, and Workers.
      password: {
        hash: hashPassword,
        verify: ({ hash, password }: { hash: string; password: string }) => verifyPassword(password, hash),
      },
    },
    user: {
      ...config.user,
      changeEmail: { enabled: true, updateEmailWithoutVerification: true, ...config.user?.changeEmail },
      additionalFields: {
        ...config.user?.additionalFields,
        // `input: false`: never settable from `/sign-up/email` or `/update-user` — a role is granted
        // through the console/API (`users:update`), never claimed by the user.
        roleId: { type: 'string', required: false, input: false },
        active: { type: 'boolean', required: false, defaultValue: true, input: false },
      },
    },
    plugins: [bearer(), ...(config.plugins ?? [])],
    databaseHooks: {
      ...config.databaseHooks,
      user: {
        ...userHooks,
        create: {
          ...userHooks?.create,
          // Self-signup (and social sign-in) gets the same blank default workspace an admin-created
          // user does (`User.operations.create`, user.model.ts).
          after: async (user, ctx) => {
            await createDefaultWorkspace({ operation: 'create', input: {}, doc: user, model: User, db });
            await userHooks?.create?.after?.(user, ctx);
          },
        },
      },
      session: {
        ...sessionHooks,
        create: {
          ...sessionHooks?.create,
          // A deactivated user (`users.active = false`) can't start a session by any method.
          before: async (session, ctx) => {
            const user = await findUserById(db, session.userId);
            if (!user || !user.active) {
              throw APIError.from('FORBIDDEN', { code: 'ACCOUNT_INACTIVE', message: 'This account is deactivated.' });
            }
            return sessionHooks?.create?.before?.(session, ctx);
          },
        },
      },
    },
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type RatchetAuth = ReturnType<typeof createRatchetAuth>;
