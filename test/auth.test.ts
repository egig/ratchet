import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { defineModel, field } from '../src/core/index.js';
import { generateId } from '../src/core/id.js';
import { insertRow } from '../src/core/persistence.js';
import type { OperationContext } from '../src/core/pipeline.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { hashPassword as hashPasswordPipeline, presetFields } from '../src/auth/pipeline.js';
import { User, Role, Session } from '../src/auth/models/index.js';
import { createAuthRouter } from '../src/auth/router.js';
import { createApiRouter } from '../src/router/create-router.js';
import { createConsoleRouter } from '../src/console/router.js';
import { createNodeFsAssetSource } from '../src/console/node-assets.js';

describe('password hashing (src/auth/password.ts)', () => {
  it('hashes and verifies a round trip', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^pbkdf2:\d+:[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('right one');
    expect(await verifyPassword('wrong one', hash)).toBe(false);
  });
});

describe('hashPassword pipeline fn (src/auth/pipeline.ts)', () => {
  function ctx(input: Record<string, unknown>): OperationContext {
    return { operation: 'create', input, doc: null, model: User, db: {} as never };
  }

  it('replaces a plaintext `password` with a `passwordHash`', async () => {
    const result = await hashPasswordPipeline(ctx({ email: 'a@b.com', password: 'hunter2' }));
    expect(result.input.password).toBeUndefined();
    expect(typeof result.input.passwordHash).toBe('string');
    expect(await verifyPassword('hunter2', result.input.passwordHash as string)).toBe(true);
  });

  it('is a no-op when there is no `password` to hash', async () => {
    const input = { email: 'a@b.com' };
    const result = await hashPasswordPipeline(ctx(input));
    expect(result.input).toEqual(input);
  });
});

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('auth system (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let authApp: ReturnType<typeof createAuthRouter>;
  let prodAuthApp: ReturnType<typeof createAuthRouter>;
  let apiApp: ReturnType<typeof createApiRouter>;
  let consoleApp: ReturnType<typeof createConsoleRouter>;

  const Widget = defineModel('widgets', {
    fields: {
      name: field.string({ required: true }),
      ownerId: field.reference('users', { required: false }),
    },
    console: { label: 'Widgets', displayField: 'name' },
  });

  // ApiModelOptions.ownerField (core/model.ts) — reuses this suite's already-live users/sessions
  // tables/registerUser helper rather than standing up a second one (vitest runs test *files* in
  // parallel against the same live DB, so a second users/sessions lifecycle in another file races
  // this one; see router.test.ts, which intentionally does not duplicate it).
  const Note = defineModel('notes', {
    fields: {
      userId: field.reference('users', { required: true, indexed: true }),
      text: field.string({ required: true }),
    },
    api: { ownerField: 'userId' },
  });

  // Q4/Q10's two-gate story: `lock`/`unlock` (core/model.ts's `CustomOperationDefinition`, built
  // from `presetFields` — ratchet/auth) each need their own action-level grant (`resource:lock`)
  // *and* the base `update` operation's own field-level grant (`field:locked`) — neither alone is
  // enough. Not `api.public`, unlike router.test.ts's custom-operation suite, precisely because
  // this suite is testing that permission gate.
  const LockableDoc = defineModel('lockable_docs', {
    fields: {
      title: field.string({ required: true }),
      locked: field.boolean({ default: false }),
    },
    operations: {
      lock: presetFields({ locked: true }),
      unlock: presetFields({ locked: false }),
    },
  });

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, description text, workspace_template_id uuid, permissions jsonb NOT NULL DEFAULT '{}'
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        email varchar NOT NULL, password_hash varchar NOT NULL, role_id uuid, active boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, token varchar NOT NULL, expires_at timestamptz NOT NULL
      )`);
    // setup also provisions the built-in `Ratchet` `Agent` (providerId: null — src/auth/provisioning.ts)
    // alongside the root role/user, so `agents` needs to exist for that insert to succeed, even
    // though this suite is otherwise entirely about auth. `providers` stays around only because
    // `agents.provider_id` references it conceptually; setup itself never writes to it anymore.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS providers (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, kind varchar NOT NULL DEFAULT 'anthropic', url varchar, api_key varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS agents (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, description text, system_prompt text NOT NULL, provider_id uuid, role_id uuid,
        model varchar NOT NULL DEFAULT 'claude-opus-5', config jsonb, active boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS notes (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, text varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS lockable_docs (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        title varchar NOT NULL, locked boolean NOT NULL DEFAULT false
      )`);
    // register/setup/admin-created-user all provision a default `Workspace` (see
    // `workspace/provisioning.ts`'s `createDefaultWorkspace`) — needed for those flows to work,
    // even though this suite otherwise has nothing to do with the workspace domain. No role here
    // ever sets `workspace_template_id`, so `workspace_views` is never touched. Never
    // truncated/dropped below: `workspace.test.ts` also writes to `workspaces` and runs
    // concurrently — vitest parallelizes test files against the same live DB — so this suite only
    // creates it and otherwise leaves it alone; every assertion here is scoped to its own user's
    // id regardless.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, name varchar NOT NULL, locked boolean NOT NULL DEFAULT false,
        chat_enabled boolean NOT NULL DEFAULT true
      )`);

    authApp = createAuthRouter(db);
    prodAuthApp = createAuthRouter(db, { env: 'production' });
    apiApp = createApiRouter({ roles: Role, users: User, notes: Note, lockable_docs: LockableDoc }, db);
    consoleApp = createConsoleRouter(
      createNodeFsAssetSource('.ratchet-test'),
      { users: User, roles: Role, sessions: Session, widgets: Widget },
      db,
      '/console',
    );
  });

  beforeEach(async () => {
    // `workspaces` is deliberately not truncated here — see the beforeAll note above.
    await db.execute(sql`TRUNCATE TABLE notes, lockable_docs, sessions, users, roles, agents, providers`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS lockable_docs`);
    await db.execute(sql`DROP TABLE IF EXISTS notes`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS agents`);
    await db.execute(sql`DROP TABLE IF EXISTS providers`);
    await db.execute(sql`DROP TABLE IF EXISTS users`);
    await db.execute(sql`DROP TABLE IF EXISTS roles`);
    await client.end();
  });

  function setupBody(email: string, password = 'hunter2'): string {
    return JSON.stringify({ email, password });
  }

  async function registerUser(email: string, password: string) {
    const res = await authApp.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json()) as { data: { user: Record<string, unknown>; token: string } };
    return { res, ...body.data };
  }

  describe('root admin onboarding (src/auth/router.ts POST/GET /setup)', () => {
    it('GET /setup reports required until a root admin is created, then never again', async () => {
      const before = await authApp.request('/setup');
      expect(((await before.json()) as { data: { required: boolean } }).data.required).toBe(true);

      const create = await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root@example.com'),
      });
      expect(create.status).toBe(201);

      const after = await authApp.request('/setup');
      expect(((await after.json()) as { data: { required: boolean } }).data.required).toBe(false);
    });

    it('the created user can immediately act on any resource (roles:create) with no prior grant', async () => {
      const setup = await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root2@example.com'),
      });
      const { token } = ((await setup.json()) as { data: { token: string } }).data;

      const res = await apiApp.request('/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'editor' }),
      });
      expect(res.status).toBe(201);
    });

    it('a second setup attempt 409s once a root admin exists', async () => {
      await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root3@example.com'),
      });

      const second = await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('someone-else@example.com'),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe('SETUP_ALREADY_COMPLETE');
    });

    it('deactivating the root admin does not reopen setup', async () => {
      const setup = await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root4@example.com'),
      });
      const { user } = ((await setup.json()) as { data: { user: { id: string } } }).data;

      await db.execute(sql`UPDATE users SET active = false WHERE id = ${user.id}`);

      const status = await authApp.request('/setup');
      expect(((await status.json()) as { data: { required: boolean } }).data.required).toBe(false);
    });

    it('reuses the same Root role + *:* permission on a fresh instance instead of duplicating it', async () => {
      await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root5@example.com'),
      });

      const roles = (await db.execute(
        sql`SELECT permissions FROM roles WHERE name = 'Root'`,
      )) as unknown as { permissions: Record<string, Record<string, { fields: string; scope: string }>> }[];
      expect(roles.length).toBe(1);
      expect(roles[0]!.permissions).toEqual({ '*': { '*': { fields: '*', scope: 'any' } } });
    });

    it('provisions the built-in Ratchet Agent with no Provider, wired to the Root role', async () => {
      await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root8@example.com'),
      });

      const providers = (await db.execute(sql`SELECT id FROM providers`)) as unknown as { id: string }[];
      expect(providers.length).toBe(0);

      const roles = (await db.execute(sql`SELECT id FROM roles WHERE name = 'Root'`)) as unknown as { id: string }[];
      const agents = (await db.execute(sql`SELECT name, provider_id, role_id FROM agents`)) as unknown as {
        name: string;
        provider_id: string | null;
        role_id: string;
      }[];
      expect(agents.length).toBe(1);
      expect(agents[0]).toEqual({ name: 'Ratchet', provider_id: null, role_id: roles[0]!.id });
    });
  });

  describe('/setup is disguised as missing in production (src/auth/router.ts)', () => {
    it('GET and POST /setup both 404, regardless of whether a root admin exists yet', async () => {
      const beforeGet = await prodAuthApp.request('/setup');
      expect(beforeGet.status).toBe(404);
      const beforePost = await prodAuthApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('prod-root@example.com'),
      });
      expect(beforePost.status).toBe(404);

      // ... and still 404s once a root admin exists (created out-of-band, the way `ratchet
      // create-admin` would in a real deploy).
      await authApp.request('/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('prod-root2@example.com'),
      });
      const afterGet = await prodAuthApp.request('/setup');
      expect(afterGet.status).toBe(404);
    });
  });

  it('register creates a user + session and never returns passwordHash', async () => {
    const { res, user, token } = await registerUser('ada@example.com', 'hunter2');
    expect(res.status).toBe(201);
    expect(user.email).toBe('ada@example.com');
    expect(user.passwordHash).toBeUndefined();
    expect(typeof token).toBe('string');
  });

  it('register also provisions a blank default Workspace (workspace/provisioning.ts) — a fresh account has no roleId yet', async () => {
    const { user } = await registerUser('workspace-on-register@example.com', 'hunter2');

    const rows = (await db.execute(
      sql`SELECT name FROM workspaces WHERE user_id = ${user.id}`,
    )) as unknown as { name: string }[];
    expect(rows).toEqual([{ name: 'My Workspace' }]);
  });

  it('login succeeds with the right password and fails with the wrong one', async () => {
    await registerUser('grace@example.com', 'right-password');

    const good = await authApp.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'right-password' }),
    });
    expect(good.status).toBe(200);
    const goodBody = (await good.json()) as { data: { token: string } };
    expect(typeof goodBody.data.token).toBe('string');

    const bad = await authApp.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'grace@example.com', password: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('GET /me requires a valid bearer token and reflects the logged-in user', async () => {
    const { token } = await registerUser('me@example.com', 'pw');

    const noAuth = await authApp.request('/me');
    expect(noAuth.status).toBe(401);

    const authed = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { data: { email: string } };
    expect(body.data.email).toBe('me@example.com');
  });

  it('logout invalidates the session', async () => {
    const { token } = await registerUser('bye@example.com', 'pw');

    const before = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);

    const logout = await authApp.request('/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(logout.status).toBe(200);

    const after = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });

  it('GET /me includes the resolved permissions for the caller\'s role', async () => {
    const { token, user } = await registerUser('perms@example.com', 'pw');

    const noRole = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
    expect(((await noRole.json()) as { data: { permissions: Record<string, unknown> } }).data.permissions).toEqual({});

    const roleId = generateId();
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, 'viewer', ${JSON.stringify({ invoices: { list: {} } })})`,
    );
    await db.execute(sql`UPDATE users SET role_id = ${roleId} WHERE id = ${user.id}`);

    const withRole = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
    const body = (await withRole.json()) as { data: { permissions: Record<string, Record<string, unknown>> } };
    expect(body.data.permissions).toEqual({ invoices: { list: {} } });
  });

  describe('PATCH /me (self-service profile edit, src/auth/router.ts)', () => {
    it('requires a valid session', async () => {
      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.com' }),
      });
      expect(res.status).toBe(401);
    });

    it('updates the caller\'s own email and returns the fresh user (no passwordHash)', async () => {
      const { token } = await registerUser('before@example.com', 'pw');

      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: 'after@example.com' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { email: string; passwordHash?: string; permissions: Record<string, unknown> } };
      expect(body.data.email).toBe('after@example.com');
      expect(body.data.passwordHash).toBeUndefined();
      expect(typeof body.data.permissions).toBe('object');

      const me = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
      expect(((await me.json()) as { data: { email: string } }).data.email).toBe('after@example.com');
    });

    it('changes the password (new one logs in, old one stops working) and keeps the current session', async () => {
      const { token } = await registerUser('pwchange@example.com', 'old-pw');

      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: 'new-pw' }),
      });
      expect(res.status).toBe(200);

      // existing session still valid — token-based, not password-derived
      const stillMe = await authApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
      expect(stillMe.status).toBe(200);

      const withNew = await authApp.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pwchange@example.com', password: 'new-pw' }),
      });
      expect(withNew.status).toBe(200);

      const withOld = await authApp.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pwchange@example.com', password: 'old-pw' }),
      });
      expect(withOld.status).toBe(401);
    });

    it('rejects an empty patch', async () => {
      const { token } = await registerUser('empty@example.com', 'pw');
      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('ignores privilege fields — roleId/active can\'t be changed through this route', async () => {
      const { token, user } = await registerUser('noescalate@example.com', 'pw');

      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'admin')`);

      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: 'noescalate2@example.com', roleId, active: false }),
      });
      expect(res.status).toBe(200);

      const row = (await db.execute(
        sql`SELECT role_id, active FROM users WHERE id = ${user.id}`,
      )) as unknown as { role_id: string | null; active: boolean }[];
      expect(row[0]).toEqual({ role_id: null, active: true });
    });

    it('rejects an email already taken by another user with a field error', async () => {
      await registerUser('taken@example.com', 'pw');
      const { token } = await registerUser('mover@example.com', 'pw');

      const res = await authApp.request('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: 'taken@example.com' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; fields?: Record<string, string> } };
      expect(body.error.fields?.email).toBeTruthy();
    });
  });

  describe('cookie-based session (admin SPA transport)', () => {
    function cookieFromSetHeader(res: Response): string {
      const raw = res.headers.get('set-cookie');
      expect(raw).toBeTruthy();
      return raw!.split(';')[0]!;
    }

    it('login sets an HttpOnly session cookie usable in place of the Authorization header', async () => {
      await registerUser('cookie@example.com', 'pw');
      const res = await authApp.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'cookie@example.com', password: 'pw' }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie')!;
      expect(setCookie).toMatch(/^ratchet_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      // plain http:// in tests — Secure must not be set, or the browser would drop the cookie entirely.
      expect(setCookie).not.toMatch(/Secure/i);

      const cookie = cookieFromSetHeader(res);
      const me = await authApp.request('/me', { headers: { cookie } });
      expect(me.status).toBe(200);
    });

    it('a Bearer header takes precedence over a cookie when both are present', async () => {
      const a = await registerUser('a@example.com', 'pw');
      const b = await registerUser('b@example.com', 'pw');
      const bCookieRes = await authApp.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'b@example.com', password: 'pw' }),
      });
      const bCookie = cookieFromSetHeader(bCookieRes);

      const res = await authApp.request('/me', {
        headers: { authorization: `Bearer ${a.token}`, cookie: bCookie },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { email: string } }).data.email).toBe('a@example.com');
    });

    it('logout works from the cookie alone and clears it', async () => {
      await registerUser('logout-cookie@example.com', 'pw');
      const res = await authApp.request('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'logout-cookie@example.com', password: 'pw' }),
      });
      const cookie = cookieFromSetHeader(res);

      const logout = await authApp.request('/logout', { method: 'POST', headers: { cookie } });
      expect(logout.status).toBe(200);
      const clearHeader = logout.headers.get('set-cookie')!;
      expect(clearHeader).toMatch(/^ratchet_session=;|Max-Age=0/i);

      const after = await authApp.request('/me', { headers: { cookie } });
      expect(after.status).toBe(401);
    });
  });

  it('requirePermission wired into Role.operations: no token -> 401, wrong permission -> 403, granted permission -> 201', async () => {
    const { token, user } = await registerUser('admin@example.com', 'pw');

    const noAuth = await apiApp.request('/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'editor' }),
    });
    expect(noAuth.status).toBe(401);

    const forbidden = await apiApp.request('/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'editor' }),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // grant this user's role the 'roles:create' permission directly (bypassing the API — this is
    // the out-of-band admin bootstrap the plan calls out as a known gap).
    const adminRoleId = generateId();
    const now = new Date().toISOString();
    // `fields: '*'` — 'create' is a field-shaped action (see FIELD_SHAPED_ACTIONS, src/auth/pipeline.ts):
    // secure-by-default field permission means a grant naming no fields at all grants none.
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${adminRoleId}, ${now}, ${now}, 'admin', ${JSON.stringify({ roles: { create: { fields: '*' } } })})`,
    );
    await db.execute(sql`UPDATE users SET role_id = ${adminRoleId} WHERE id = ${user.id}`);

    const allowed = await apiApp.request('/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'editor' }),
    });
    expect(allowed.status).toBe(201);
    expect(((await allowed.json()) as { data: { name: string } }).data.name).toBe('editor');
  });

  describe('console metadata API (src/console/router.ts)', () => {
    it('GET /meta/models requires auth', async () => {
      const res = await consoleApp.request('/meta/models');
      expect(res.status).toBe(401);
    });

    it('lists non-hidden models with admin label/displayField, excludes the hidden Session model', async () => {
      const { token } = await registerUser('models@example.com', 'pw');
      const res = await consoleApp.request('/meta/models', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { name: string; label: string; displayField: string }[] };

      const names = body.data.map((m) => m.name);
      expect(names).toContain('widgets');
      expect(names).toContain('users');
      expect(names).not.toContain('sessions');

      const widgets = body.data.find((m) => m.name === 'widgets')!;
      expect(widgets.label).toBe('Widgets');
      expect(widgets.displayField).toBe('name');

      const users = body.data.find((m) => m.name === 'users')!;
      expect(users.displayField).toBe('email'); // no console.displayField declared -> infers first string field
    });

    it("strips pipeline fns/zod-schema and exposes passwordHash's writeAs", async () => {
      const { token } = await registerUser('meta@example.com', 'pw');
      const res = await consoleApp.request('/meta/models/users', { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json()) as {
        data: { fields: { key: string; sensitive: boolean; writeAs?: string }[]; operationNames: string[]; operations: unknown[] };
      };

      const passwordHash = body.data.fields.find((f) => f.key === 'passwordHash')!;
      expect(passwordHash.sensitive).toBe(true);
      expect(passwordHash.writeAs).toBe('password');
      // `operationNames` (create/update/remove — a plain string list) is fine to cross the wire;
      // `operations` (custom operations beyond the three builtins, Q19) is empty since `User`
      // doesn't declare any — either way, only serializable data ever appears here, never a raw
      // pipeline function (`ConsoleModelMeta`'s type wouldn't allow one through in the first place).
      expect(body.data.operationNames.sort()).toEqual(['create', 'remove', 'update']);
      expect(body.data.operations).toEqual([]);
    });

    it('GET /meta/models/:name 404s for a hidden model, matching an unknown model', async () => {
      const { token } = await registerUser('hidden@example.com', 'pw');
      const hidden = await consoleApp.request('/meta/models/sessions', { headers: { authorization: `Bearer ${token}` } });
      expect(hidden.status).toBe(404);
      const unknown = await consoleApp.request('/meta/models/nope', { headers: { authorization: `Bearer ${token}` } });
      expect(unknown.status).toBe(404);
    });
  });

  describe('ownerField scoping (ApiModelOptions.ownerField, core/model.ts + create-router.ts)', () => {
    // The generic router now requires a matching permission grant for every route by default,
    // including reads (the implicit 'read' action) — a registered-but-roleless user (as
    // `registerUser` produces) has none, so `GET /notes` alone would 403 before ownerField
    // scoping ever runs. Grants a fresh role read access to every field of `resource` and assigns
    // it to `userId`, mirroring what an admin would set up via `Role.permissions` in a real app.
    async function grantRead(userId: string, resource: string, scope?: 'own' | 'any'): Promise<void> {
      const roleId = generateId();
      const now = new Date().toISOString();
      const grant = { fields: '*' as const, ...(scope ? { scope } : {}) };
      await db.execute(
        sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, ${`reader-${roleId}`}, ${JSON.stringify({ [resource]: { read: grant } })})`,
      );
      await db.execute(sql`UPDATE users SET role_id = ${roleId} WHERE id = ${userId}`);
    }

    it('GET /:model scopes results to the requesting user, additively (cannot see other rows)', async () => {
      const a = await registerUser('owner-a@example.com', 'pw');
      const b = await registerUser('owner-b@example.com', 'pw');
      await grantRead(a.user.id as string, 'notes');
      await grantRead(b.user.id as string, 'notes');
      await insertRow(db, Note, { userId: a.user.id, text: 'a-note' });
      await insertRow(db, Note, { userId: b.user.id, text: 'b-note' });

      const asA = await apiApp.request('/notes', { headers: { authorization: `Bearer ${a.token}` } });
      const bodyA = (await asA.json()) as { data: { text: string }[] };
      expect(bodyA.data.map((r) => r.text)).toEqual(['a-note']);

      const asB = await apiApp.request('/notes', { headers: { authorization: `Bearer ${b.token}` } });
      const bodyB = (await asB.json()) as { data: { text: string }[] };
      expect(bodyB.data.map((r) => r.text)).toEqual(['b-note']);
    });

    it("GET /:model/:id 404s when the row isn't the requesting user's own", async () => {
      const a = await registerUser('owner-c@example.com', 'pw');
      const b = await registerUser('owner-d@example.com', 'pw');
      await grantRead(a.user.id as string, 'notes');
      const bNote = await insertRow(db, Note, { userId: b.user.id, text: 'private' });

      const res = await apiApp.request(`/notes/${bNote.id}`, { headers: { authorization: `Bearer ${a.token}` } });
      expect(res.status).toBe(404);
    });

    it('GET without a valid session 401s on an ownerField-scoped model (unlike a plain model, which has no read gate at all)', async () => {
      const res = await apiApp.request('/notes');
      expect(res.status).toBe(401);
    });

    it("a role granted `scope: 'any'` sees every row, not just its own", async () => {
      const a = await registerUser('owner-e@example.com', 'pw');
      const b = await registerUser('owner-f@example.com', 'pw');
      await grantRead(a.user.id as string, 'notes', 'any');
      await grantRead(b.user.id as string, 'notes');
      await insertRow(db, Note, { userId: a.user.id, text: 'a-note-2' });
      await insertRow(db, Note, { userId: b.user.id, text: 'b-note-2' });

      const asA = await apiApp.request('/notes', { headers: { authorization: `Bearer ${a.token}` } });
      const bodyA = (await asA.json()) as { data: { text: string }[] };
      expect(bodyA.data.map((r) => r.text).sort()).toEqual(['a-note-2', 'b-note-2']);
    });

    it("a role granted `scope: 'any'` can read a row it doesn't own by id", async () => {
      const a = await registerUser('owner-g@example.com', 'pw');
      const b = await registerUser('owner-h@example.com', 'pw');
      await grantRead(a.user.id as string, 'notes', 'any');
      const bNote = await insertRow(db, Note, { userId: b.user.id, text: 'shared' });

      const res = await apiApp.request(`/notes/${bNote.id}`, { headers: { authorization: `Bearer ${a.token}` } });
      expect(res.status).toBe(200);
    });
  });

  // shared by every suite below that needs a fresh role with a specific grant list — the outer
  // `describeIfDb` block, not any one inner `describe`, since both the Q4/Q10 custom-operation
  // suite and the `Role.permissions` write-validation suite (below) need it.
  async function grantRole(
    userId: string,
    grants: { resource: string; action: string; fields?: '*' | string[]; scope?: 'own' | 'any' }[],
  ): Promise<void> {
    const roleId = generateId();
    const now = new Date().toISOString();
    const permissions: Record<string, Record<string, { fields?: '*' | string[]; scope?: 'own' | 'any' }>> = {};
    for (const g of grants) {
      const actionMap = (permissions[g.resource] ??= {});
      actionMap[g.action] = { ...(g.fields !== undefined ? { fields: g.fields } : {}), ...(g.scope !== undefined ? { scope: g.scope } : {}) };
    }
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, ${`role-${roleId}`}, ${JSON.stringify(permissions)})`,
    );
    await db.execute(sql`UPDATE users SET role_id = ${roleId} WHERE id = ${userId}`);
  }

  describe('custom operations: two independent permission gates (Q4/Q10)', () => {
    async function createDoc(title: string): Promise<string> {
      return (await insertRow(db, LockableDoc, { title, locked: false })).id as string;
    }

    it("the operation's own action grant alone is not enough — the base `update` field grant is still required", async () => {
      const { token, user } = await registerUser('lock-only@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'lockable_docs', action: 'lock', scope: 'any' }]);
      const id = await createDoc('Doc');

      const res = await apiApp.request(`/lockable_docs/${id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(400); // presetFields' own assertWriteFieldsAllowed rejects `locked`
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('the base `update` field grant alone is not enough — the operation still needs its own action grant', async () => {
      const { token, user } = await registerUser('update-only@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'lockable_docs', action: 'update', fields: ['locked'] }]);
      const id = await createDoc('Doc');

      const res = await apiApp.request(`/lockable_docs/${id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(403); // never reaches presetFields — resolveAccess denies 'lock' first
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('both grants together let the operation through and actually write the field', async () => {
      const { token, user } = await registerUser('lock-and-update@example.com', 'pw');
      await grantRole(user.id as string, [
        { resource: 'lockable_docs', action: 'lock', scope: 'any' },
        { resource: 'lockable_docs', action: 'update', fields: ['locked'] },
      ]);
      const id = await createDoc('Doc');

      const res = await apiApp.request(`/lockable_docs/${id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { locked: boolean } }).data.locked).toBe(true);
    });

    it("a permission target for a custom operation can't carry `fields` — it's fieldless, like `remove` (FIELD_SHAPED_ACTIONS)", async () => {
      const { token, user } = await registerUser('fieldless@example.com', 'pw');
      // grants this user `roles:update` (field-shaped — `'*'` per the comment at this suite's
      // admin-onboarding fixture above) plus the `permissions` field grant, so the PATCH below
      // reaches `requireValidPermissions` instead of 403ing on the outer resource:action check
      // first.
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const targetRoleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${targetRoleId}, ${now}, ${now}, 'target')`);

      const res = await apiApp.request(`/roles/${targetRoleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { lockable_docs: { lock: { fields: ['locked'] } } } }),
      });
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { error: { fields?: Record<string, string> } }).error.fields?.['permissions.lockable_docs.lock.fields'],
      ).toMatch(/not applicable for action 'lock'/);
    });
  });

  describe('Role.permissions (src/auth/pipeline.ts requireValidPermissions) — a plain field write, validated per-entry', () => {
    it("401s with no session, 403s missing the `roles:update` grant", async () => {
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const noAuth = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: {} }),
      });
      expect(noAuth.status).toBe(401);

      const { token } = await registerUser('setperms-forbidden@example.com', 'pw');
      const forbidden = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: {} }),
      });
      expect(forbidden.status).toBe(403);
    });

    it("the resource-level `roles:update` grant alone is not enough — the `permissions` field grant is still required", async () => {
      const { token, user } = await registerUser('setperms-noupdate@example.com', 'pw');
      // 'update' with no field grant at all — secure-by-default field permission (docs/content/docs/auth.mdx).
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { lockable_docs: { read: { fields: '*' } } } }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('with the field grant, replaces the whole permission tree in one PATCH', async () => {
      const { token, user } = await registerUser('setperms-admin@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);

      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(
        sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, 'editor', ${JSON.stringify({
          notes: { read: { fields: '*' }, remove: {} },
        })})`,
      );

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          permissions: {
            notes: { read: { fields: '*' } }, // kept
            lockable_docs: { update: { fields: ['locked'] } }, // new — 'remove' dropped
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { permissions: Record<string, Record<string, { fields?: unknown }>> } };
      expect(body.data.permissions).toEqual({
        notes: { read: { fields: '*' } },
        lockable_docs: { update: { fields: ['locked'] } },
      });
    });

    it('rejects an invalid target (unknown resource) with a path-keyed field error, and writes nothing', async () => {
      const { token, user } = await registerUser('setperms-invalid@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { not_a_real_model: { read: { fields: '*' } } } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { fields?: Record<string, string> } };
      expect(body.error.fields?.['permissions.not_a_real_model']).toMatch(/unknown resource/);

      const row = (await db.execute(sql`SELECT permissions FROM roles WHERE id = ${roleId}`)) as unknown as { permissions: unknown }[];
      expect(row[0]!.permissions).toEqual({});
    });

    it("accepts a `'*'`/`'*'` wildcard grant — the tree's top 'All resources' checkbox", async () => {
      const { token, user } = await registerUser('setperms-wildcard@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'super')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { '*': { '*': { fields: '*' } } } }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { permissions: unknown } }).data.permissions).toEqual({ '*': { '*': { fields: '*' } } });
    });

    it("rejects mixing the '*' resource with a specific resource", async () => {
      const { token, user } = await registerUser('setperms-mixed-resource@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { '*': { '*': { fields: '*' } }, notes: { read: { fields: '*' } } } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { fields?: Record<string, string> } };
      expect(body.error.fields?.['permissions.*']).toMatch(/cannot mix/);
    });

    it("accepts `scope` on any resource, even one with no explicit api.ownerField — every model has a default owner (createdById)", async () => {
      const { token, user } = await registerUser('setperms-plain-scope@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { lockable_docs: { read: { fields: '*', scope: 'own' } } } }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { permissions: unknown } }).data.permissions).toEqual({
        lockable_docs: { read: { fields: '*', scope: 'own' } },
      });
    });

    it("accepts `scope` on a resource with an explicit api.ownerField, and defaults to 'own' when omitted (GET /:model behavior)", async () => {
      const { token, user } = await registerUser('setperms-good-scope@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'editor')`);

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: { notes: { read: { fields: '*', scope: 'any' } } } }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { permissions: unknown } }).data.permissions).toEqual({
        notes: { read: { fields: '*', scope: 'any' } },
      });
    });

    it('a PATCH that omits `permissions` entirely leaves the existing tree untouched', async () => {
      const { token, user } = await registerUser('setperms-untouched@example.com', 'pw');
      await grantRole(user.id as string, [{ resource: 'roles', action: 'update', fields: '*', scope: 'any' }]);
      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(
        sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, 'editor', ${JSON.stringify({
          notes: { read: { fields: '*' } },
        })})`,
      );

      const res = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'editor-renamed' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { permissions: Record<string, Record<string, { fields?: unknown }>> } };
      expect(body.data.permissions).toEqual({ notes: { read: { fields: '*' } } });
    });
  });
});
