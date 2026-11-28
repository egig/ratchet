import { App, type Ctx } from '../router/http-app.js';
import type { AnyDb } from '../core/db.js';
import { PipelineError } from '../core/pipeline.js';
import { redactSensitiveFields } from '../core/serialize.js';
import { toErrorResponse } from '../router/errors.js';
import { readJsonBody } from '../router/create-router.js';
import { User } from './models/index.js';
import { createRatchetAuth, type AuthConfig, type RatchetAuth } from './better-auth.js';
import { provisionRootAdmin } from './provisioning.js';
import { hasRootAdmin, listPermissionsForRole } from './lookup.js';
import type { PluginSetupInfo } from '../plugin/types.js';

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { [key]: 'required' } });
  }
  return value;
}

/** Copies every `Set-Cookie` (and better-auth's `set-auth-token`) from a better-auth response onto
 * the response `c` is about to build. */
function forwardAuthHeaders(c: Ctx, headers: Headers): void {
  for (const cookie of headers.getSetCookie()) c.appendHeader('Set-Cookie', cookie);
  const token = headers.get('set-auth-token');
  if (token) c.appendHeader('set-auth-token', token);
}

export interface AuthRouterOptions {
  env?: 'development' | 'production';
  /** better-auth options (`FrameworkConfig.auth`) — see `AuthConfig`. */
  config?: AuthConfig;
  /** an already-built instance, for callers that also need `auth.api` themselves. */
  auth?: RatchetAuth;
  /** plugin setup hooks, run inside the `/setup` provisioning transaction (see `provisionRootAdmin`) */
  onSetup?: (info: PluginSetupInfo) => Promise<void>;
}

/**
 * `/api/auth/*`. Ratchet's own routes come first, then everything else is better-auth's handler:
 * `/sign-up/email`, `/sign-in/email`, `/sign-in/social`, `/callback/:provider`, `/sign-out`,
 * `/get-session`, `/update-user`, `/change-email`, `/change-password`, `/request-password-reset`,
 * `/reset-password`, `/verify-email`, `/list-sessions`, plus whatever `config.plugins` add.
 *
 * Must be mounted at exactly `/api/auth` (better-auth's `basePath`, `AUTH_BASE_PATH`) and before the
 * generic `/api/:model` router, so this more specific prefix wins.
 *
 * `opts.env === 'production'` disguises `/setup` entirely: both routes 404 exactly as a genuinely
 * unmatched route would, so the endpoint's presence never reveals whether a root admin exists.
 * Production's only bootstrap path is the `ratchet create-admin` CLI command, which calls
 * `provisionRootAdmin` directly against the DB.
 */
export function createAuthRouter(db: AnyDb, opts: AuthRouterOptions = {}): App {
  const auth = opts.auth ?? createRatchetAuth(db, opts.config);
  const app = new App();

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  app.get('/setup', async (c) => {
    if (opts.env === 'production') throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    return c.json({ data: { required: !(await hasRootAdmin(db)) } });
  });

  /** Creates the root admin, then signs them in through better-auth itself, so the session and
   * cookie are exactly what `/sign-in/email` would have produced. */
  app.post('/setup', async (c) => {
    if (opts.env === 'production') throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    const body = await readJsonBody(c);
    const email = requireString(body, 'email');
    const password = requireString(body, 'password');

    const user = await provisionRootAdmin(db, { email, password }, opts.onSetup);

    const res = await auth.api.signInEmail({ body: { email, password }, headers: c.req.raw.headers, asResponse: true });
    if (!res.ok) throw new PipelineError({ code: 'INTERNAL', status: 500, message: 'setup: sign-in after provisioning failed' });
    const { token } = (await res.json()) as { token: string };
    forwardAuthHeaders(c, res.headers);
    return c.json({ data: { user: redactSensitiveFields(User, user), token } }, 201);
  });

  /** The signed-in user plus their role's resolved permission tree — what the console needs on
   * every page load. Goes through better-auth's `getSession` (cookie or Bearer), so a session past
   * its `updateAge` gets its expiry extended and its cookie refreshed here. */
  app.get('/me', async (c) => {
    const { headers, response } = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    const user = response?.user as (Record<string, unknown> & { roleId?: string | null; active?: boolean }) | undefined;
    if (!user || user.active === false) {
      throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'invalid or expired session' });
    }
    forwardAuthHeaders(c, headers);
    const permissions = typeof user.roleId === 'string' ? await listPermissionsForRole(db, user.roleId) : {};
    return c.json({ data: { ...redactSensitiveFields(User, user), roleId: user.roleId ?? null, permissions } });
  });

  const delegate = (c: Ctx) => auth.handler(c.req.raw);
  app.get('/*', delegate);
  app.post('/*', delegate);
  app.put('/*', delegate);
  app.patch('/*', delegate);
  app.delete('/*', delegate);

  return app;
}
