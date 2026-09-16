import { App, type Ctx, setCookie, deleteCookie } from '../router/http-app.js';
import type { AnyDb } from '../core/db.js';
import type { OperationContext } from '../core/pipeline.js';
import { PipelineError } from '../core/pipeline.js';
import { redactSensitiveFields } from '../core/serialize.js';
import { generateId } from '../core/id.js';
import { toErrorResponse } from '../router/errors.js';
import { readJsonBody } from '../router/create-router.js';
import { User, registerPipeline } from './models/index.js';
import { resolveSessionUser } from './pipeline.js';
import { provisionRootAdmin } from './provisioning.js';
import { deleteSessionByToken, findUserByEmail, hasRootAdmin, insertSession, listPermissionsForRole, type UserRow } from './lookup.js';
import { verifyPassword } from './password.js';
import { generateToken, sessionExpiry } from './token.js';
import { resolveSessionToken, SESSION_COOKIE_NAME } from './cookie.js';


function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { [key]: 'required' } });
  }
  return value;
}

async function issueSession(db: AnyDb, userId: string) {
  const token = generateToken();
  const now = new Date();
  const session = await insertSession(db, generateId(), userId, token, sessionExpiry(now), now);
  return session.token;
}

/** Mirrors the token onto an `HttpOnly` cookie so the console SPA (no manual header injection)
 * and non-browser API clients (the `Authorization` header, still returned in the body) both
 * work. `Secure` is conditional on the request's own protocol — hardcoding it on would break
 * plain-http `ratchet dev`. */
function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // matches SESSION_TTL_MS in token.ts
  });
}

function clearSessionCookie(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}

function redactUser(user: UserRow): Record<string, unknown> {
  return redactSensitiveFields(User, user as unknown as Record<string, unknown>);
}

async function userWithPermissions(db: AnyDb, user: UserRow): Promise<Record<string, unknown>> {
  const permissions = typeof user.roleId === 'string' ? await listPermissionsForRole(db, user.roleId) : {};
  return { ...redactUser(user), permissions };
}

/** `/api/auth/*` — setup/register/login/logout/me. Mount before the generic `/api/:model`
 * router (src/router/create-router.ts) so this more specific prefix wins.
 *
 * `opts.env === 'production'` disguises `/setup` entirely: both routes 404 exactly as a genuinely
 * unmatched route would, so the endpoint's presence never reveals whether a root admin exists.
 * Production's only bootstrap path is the `ratchet create-admin` CLI command, which calls
 * `provisionRootAdmin` directly against the DB. */
export function createAuthRouter(db: AnyDb, opts: { env?: 'development' | 'production' } = {}): App {
  const app = new App();

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  app.get('/setup', async (c) => {
    if (opts.env === 'production') throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    return c.json({ data: { required: !(await hasRootAdmin(db)) } });
  });

  app.post('/setup', async (c) => {
    if (opts.env === 'production') throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    const body = await readJsonBody(c);
    const email = requireString(body, 'email');
    const password = requireString(body, 'password');

    const user = await provisionRootAdmin(db, { email, password });

    const token = await issueSession(db, user.id as string);
    setSessionCookie(c, token);
    return c.json({ data: { user: redactSensitiveFields(User, user), token } }, 201);
  });

  app.post('/register', async (c) => {
    const body = await readJsonBody(c);
    const input = { email: requireString(body, 'email'), password: requireString(body, 'password') };

    const ctx: OperationContext = { operation: 'create', input, doc: null, model: User, db, request: c.req.raw };
    const result = await registerPipeline(ctx);
    const doc = result.doc!;

    const token = await issueSession(db, doc.id as string);
    setSessionCookie(c, token);
    return c.json({ data: { user: redactSensitiveFields(User, doc), token } }, 201);
  });

  app.post('/login', async (c) => {
    const body = await readJsonBody(c);
    const email = requireString(body, 'email');
    const password = requireString(body, 'password');

    const user = await findUserByEmail(db, email);
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !user.active || !valid) {
      throw new PipelineError({ code: 'INVALID_CREDENTIALS', status: 401 });
    }

    const token = await issueSession(db, user.id);
    setSessionCookie(c, token);
    return c.json({ data: { user: redactUser(user), token } });
  });

  app.post('/logout', async (c) => {
    const token = resolveSessionToken(c.req.raw);
    if (!token) {
      throw new PipelineError({ code: 'UNAUTHENTICATED', status: 401, message: 'missing bearer token or session cookie' });
    }
    await deleteSessionByToken(db, token);
    clearSessionCookie(c);
    return c.json({ data: null });
  });

  app.get('/me', async (c) => {
    const user = await resolveSessionUser(db, c.req.raw);
    return c.json({ data: await userWithPermissions(db, user) });
  });

  /** Self-service profile edit — lets any authenticated user change their own `email`/`password`
   * without the `users:update` permission that gates admin-driven edits through the generic
   * `PATCH /api/users/:id`. Only those two keys are honoured (a client can't lift its own role or
   * reactivate itself here); the write itself still runs through `User.operations.update`, so
   * `hashPassword` + `validate` apply exactly as they would for an admin edit. */
  app.patch('/me', async (c) => {
    const current = await resolveSessionUser(db, c.req.raw);
    const body = await readJsonBody(c);

    const input: Record<string, unknown> = {};
    if (typeof body.email === 'string' && body.email.length > 0) input.email = body.email;
    if (typeof body.password === 'string' && body.password.length > 0) input.password = body.password;
    if (Object.keys(input).length === 0) {
      throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, message: 'nothing to update' });
    }

    // Friendly duplicate-email check — the partial unique index on `users.email` would otherwise
    // surface as a raw 500 (no unique-violation mapping anywhere in the framework yet).
    if (typeof input.email === 'string' && input.email !== current.email) {
      const existing = await findUserByEmail(db, input.email);
      if (existing && existing.id !== current.id) {
        throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { email: 'already in use' } });
      }
    }

    const ctx: OperationContext = {
      operation: 'update',
      id: current.id,
      input,
      doc: null,
      model: User,
      db,
      request: c.req.raw,
    };
    const result = await User.operations.update(ctx);
    return c.json({ data: await userWithPermissions(db, result.doc as unknown as UserRow) });
  });

  return app;
}
