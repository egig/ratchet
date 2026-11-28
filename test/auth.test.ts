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
import { presetFields } from '../src/auth/pipeline.js';
import { resolveSessionToken } from '../src/auth/cookie.js';
import { User, Role, Session } from '../src/auth/models/index.js';
import { createAuthRouter } from '../src/auth/router.js';
import { App } from '../src/router/http-app.js';
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

describe('resolveSessionToken (src/auth/cookie.ts)', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

  it('reads a raw Bearer token, and strips the signature from a signed one', () => {
    expect(resolveSessionToken(req({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(resolveSessionToken(req({ authorization: 'bearer abc123.c2lnbmF0dXJl' }))).toBe('abc123');
  });

  it("reads better-auth's session cookie, plain or __Secure- prefixed, URL-encoded and signed", () => {
    expect(resolveSessionToken(req({ cookie: 'a=1; ratchet.session_token=tok.sig%3D' }))).toBe('tok');
    expect(resolveSessionToken(req({ cookie: '__Secure-ratchet.session_token=tok2.sig' }))).toBe('tok2');
  });

  it('prefers the Bearer header over the cookie, and returns null when neither is present', () => {
    expect(resolveSessionToken(req({ authorization: 'Bearer head', cookie: 'ratchet.session_token=cook.sig' }))).toBe('head');
    expect(resolveSessionToken(req({ cookie: 'other=1' }))).toBeNull();
  });
});

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('auth system (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let authApp: App;
  let setupCalls: { rootRoleId: string; userId: string; inTx: boolean }[] = [];
  let prodAuthApp: App;
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
        email varchar NOT NULL, name varchar, email_verified boolean NOT NULL DEFAULT false, image varchar,
        role_id uuid, active boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, token varchar NOT NULL, expires_at timestamptz NOT NULL, ip_address varchar, user_agent text
      )`);
    // better-auth's own tables (src/auth/models/account.model.ts, verification.model.ts).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS accounts (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, account_id varchar NOT NULL, provider_id varchar NOT NULL, password text,
        access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz,
        refresh_token_expires_at timestamptz, scope text
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS verifications (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        identifier varchar NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL
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

    // mounted at `/api/auth` exactly as `createRatchetApp` does — better-auth's handler matches on
    // the full path (its `basePath`).
    const secret = 'test-secret-test-secret-test-secret-0123';
    authApp = new App();
    authApp.route(
      '/api/auth',
      createAuthRouter(db, {
        config: { secret, baseURL: 'http://localhost' },
        onSetup: async ({ tx, rootRoleId, userId }) => {
          setupCalls.push({ rootRoleId, userId, inTx: tx !== db });
        },
      }),
    );
    prodAuthApp = new App();
    prodAuthApp.route('/api/auth', createAuthRouter(db, { env: 'production', config: { secret, baseURL: 'http://localhost' } }));
    apiApp = createApiRouter({ roles: Role, users: User, notes: Note, lockable_docs: LockableDoc }, db);
    consoleApp = createConsoleRouter(
      createNodeFsAssetSource('.ratchet-test'),
      { users: User, roles: Role, sessions: Session, widgets: Widget },
      db,
      '/console',
    );
  });

  beforeEach(async () => {
    setupCalls = [];
    // `workspaces` is deliberately not truncated here — see the beforeAll note above.
    await db.execute(sql`TRUNCATE TABLE notes, lockable_docs, sessions, accounts, verifications, users, roles, agents, providers`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS lockable_docs`);
    await db.execute(sql`DROP TABLE IF EXISTS notes`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS accounts`);
    await db.execute(sql`DROP TABLE IF EXISTS verifications`);
    await db.execute(sql`DROP TABLE IF EXISTS agents`);
    await db.execute(sql`DROP TABLE IF EXISTS providers`);
    await db.execute(sql`DROP TABLE IF EXISTS users`);
    await db.execute(sql`DROP TABLE IF EXISTS roles`);
    await client.end();
  });

  const PW = 'password-1';

  function setupBody(email: string, password = 'hunter2-hunter2'): string {
    return JSON.stringify({ email, password });
  }

  function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return authApp.request(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /** better-auth's `/sign-up/email` — returns `{ token, user }` directly (no `{ data }` envelope). */
  async function registerUser(email: string, password: string = PW) {
    const res = await post('/sign-up/email', { email, password, name: '' });
    const body = (await res.json()) as { user: Record<string, unknown>; token: string };
    return { res, ...body };
  }

  function signIn(email: string, password: string) {
    return post('/sign-in/email', { email, password });
  }

  describe('root admin onboarding (src/auth/router.ts POST/GET /setup)', () => {
    it('GET /setup reports required until a root admin is created, then never again', async () => {
      const before = await authApp.request('/api/auth/setup');
      expect(((await before.json()) as { data: { required: boolean } }).data.required).toBe(true);

      const create = await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root@example.com'),
      });
      expect(create.status).toBe(201);

      const after = await authApp.request('/api/auth/setup');
      expect(((await after.json()) as { data: { required: boolean } }).data.required).toBe(false);
    });

    it('the created user can immediately act on any resource (roles:create) with no prior grant', async () => {
      const setup = await authApp.request('/api/auth/setup', {
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
      await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root3@example.com'),
      });

      const second = await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('someone-else@example.com'),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe('SETUP_ALREADY_COMPLETE');
    });

    it('deactivating the root admin does not reopen setup', async () => {
      const setup = await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root4@example.com'),
      });
      const { user } = ((await setup.json()) as { data: { user: { id: string } } }).data;

      await db.execute(sql`UPDATE users SET active = false WHERE id = ${user.id}`);

      const status = await authApp.request('/api/auth/setup');
      expect(((await status.json()) as { data: { required: boolean } }).data.required).toBe(false);
    });

    it('reuses the same Root role + *:* permission on a fresh instance instead of duplicating it', async () => {
      await authApp.request('/api/auth/setup', {
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

    it("runs the plugin setup hooks inside the provisioning transaction, with the Root role and the new user", async () => {
      const res = await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('root8@example.com'),
      });
      expect(res.status).toBe(201);

      const roles = (await db.execute(sql`SELECT id FROM roles WHERE name = 'Root'`)) as unknown as { id: string }[];
      const users = (await db.execute(sql`SELECT id FROM users WHERE email = 'root8@example.com'`)) as unknown as { id: string }[];
      expect(setupCalls).toEqual([{ rootRoleId: roles[0]!.id, userId: users[0]!.id, inTx: true }]);
      // core seeds no agent of its own — that's the automation plugin's `onSetup` now
      const agents = (await db.execute(sql`SELECT id FROM agents`)) as unknown as unknown[];
      expect(agents.length).toBe(0);
    });
  });

  describe('/setup is disguised as missing in production (src/auth/router.ts)', () => {
    it('GET and POST /setup both 404, regardless of whether a root admin exists yet', async () => {
      const beforeGet = await prodAuthApp.request('/api/auth/setup');
      expect(beforeGet.status).toBe(404);
      const beforePost = await prodAuthApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('prod-root@example.com'),
      });
      expect(beforePost.status).toBe(404);

      // ... and still 404s once a root admin exists (created out-of-band, the way `ratchet
      // create-admin` would in a real deploy).
      await authApp.request('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: setupBody('prod-root2@example.com'),
      });
      const afterGet = await prodAuthApp.request('/api/auth/setup');
      expect(afterGet.status).toBe(404);
    });
  });

  it('sign-up creates a user + session and never returns password data', async () => {
    const { res, user, token } = await registerUser('ada@example.com');
    expect(res.status).toBe(200);
    expect(user.email).toBe('ada@example.com');
    expect(user.password).toBeUndefined();
    expect(user.passwordHash).toBeUndefined();
    expect(typeof token).toBe('string');

    // the password lives on a better-auth `credential` account, hashed with Ratchet's PBKDF2 format
    const accounts = (await db.execute(
      sql`SELECT provider_id, account_id, password FROM accounts WHERE user_id = ${user.id}`,
    )) as unknown as { provider_id: string; account_id: string; password: string }[];
    expect(accounts.length).toBe(1);
    expect(accounts[0]!.provider_id).toBe('credential');
    expect(accounts[0]!.password).toMatch(/^pbkdf2:/);
  });

  it('sign-up also provisions a blank default Workspace (workspace/provisioning.ts) — a fresh account has no roleId yet', async () => {
    const { user } = await registerUser('workspace-on-register@example.com');

    const rows = (await db.execute(
      sql`SELECT name FROM workspaces WHERE user_id = ${user.id}`,
    )) as unknown as { name: string }[];
    expect(rows).toEqual([{ name: 'My Workspace' }]);
  });

  it("sign-up can't claim a role or set `active` — both are better-auth `input: false` fields", async () => {
    const roleId = generateId();
    const now = new Date().toISOString();
    await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'admin')`);

    const res = await post('/sign-up/email', { email: 'climber@example.com', password: PW, name: '', roleId, active: false });
    const rows = (await db.execute(sql`SELECT role_id, active FROM users WHERE email = 'climber@example.com'`)) as unknown as {
      role_id: string | null;
      active: boolean;
    }[];
    // better-auth either rejects the body outright or drops the fields — never applies them
    if (res.ok) expect(rows[0]).toEqual({ role_id: null, active: true });
    else expect(rows.length).toBe(0);
  });

  it('sign-in succeeds with the right password and fails with the wrong one', async () => {
    await registerUser('grace@example.com', 'right-password');

    const good = await signIn('grace@example.com', 'right-password');
    expect(good.status).toBe(200);
    expect(typeof ((await good.json()) as { token: string }).token).toBe('string');

    const bad = await signIn('grace@example.com', 'nope-nope-nope');
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('a deactivated user cannot sign in, and their existing session stops resolving', async () => {
    const { token, user } = await registerUser('inactive@example.com');
    await db.execute(sql`UPDATE users SET active = false WHERE id = ${user.id}`);

    const res = await signIn('inactive@example.com', PW);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ACCOUNT_INACTIVE');

    const me = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(401);
    const api = await apiApp.request('/roles', { headers: { authorization: `Bearer ${token}` } });
    expect(api.status).toBe(401);
  });

  it('a soft-deleted user cannot sign in (the adapter only sees live rows)', async () => {
    const { user } = await registerUser('deleted@example.com');
    await db.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${user.id}`);
    const res = await signIn('deleted@example.com', PW);
    expect(res.status).toBe(401);
  });

  it('a password hashed before the better-auth migration still verifies', async () => {
    const userId = generateId();
    const now = new Date().toISOString();
    await db.execute(sql`INSERT INTO users (id, created_at, updated_at, email, name) VALUES (${userId}, ${now}, ${now}, 'legacy@example.com', '')`);
    await db.execute(
      sql`INSERT INTO accounts (id, created_at, updated_at, user_id, account_id, provider_id, password)
          VALUES (${generateId()}, ${now}, ${now}, ${userId}, ${userId}, 'credential', ${await hashPassword('legacy-password')})`,
    );
    const res = await signIn('legacy@example.com', 'legacy-password');
    expect(res.status).toBe(200);
  });

  it('GET /me requires a valid session and reflects the signed-in user', async () => {
    const { token } = await registerUser('me@example.com');

    const noAuth = await authApp.request('/api/auth/me');
    expect(noAuth.status).toBe(401);

    const authed = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as { data: { email: string; roleId: string | null; active: boolean } };
    expect(body.data.email).toBe('me@example.com');
    expect(body.data.roleId).toBeNull();
    expect(body.data.active).toBe(true);
  });

  it('sign-out invalidates the session', async () => {
    const { token } = await registerUser('bye@example.com');

    const before = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);

    const signOut = await post('/sign-out', {}, { authorization: `Bearer ${token}` });
    expect(signOut.status).toBe(200);

    const after = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
    const api = await apiApp.request('/roles', { headers: { authorization: `Bearer ${token}` } });
    expect(api.status).toBe(401);
  });

  it("GET /me includes the resolved permissions for the caller's role", async () => {
    const { token, user } = await registerUser('perms@example.com');

    const noRole = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    expect(((await noRole.json()) as { data: { permissions: Record<string, unknown> } }).data.permissions).toEqual({});

    const roleId = generateId();
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions) VALUES (${roleId}, ${now}, ${now}, 'viewer', ${JSON.stringify({ invoices: { list: {} } })})`,
    );
    await db.execute(sql`UPDATE users SET role_id = ${roleId} WHERE id = ${user.id}`);

    const withRole = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    const body = (await withRole.json()) as { data: { roleId: string; permissions: Record<string, Record<string, unknown>> } };
    expect(body.data.roleId).toBe(roleId);
    expect(body.data.permissions).toEqual({ invoices: { list: {} } });
  });

  describe('self-service profile (better-auth /change-email, /change-password, /update-user)', () => {
    it("changes the caller's own email", async () => {
      const { token } = await registerUser('before@example.com');

      const res = await post('/change-email', { newEmail: 'after@example.com' }, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);

      const me = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
      expect(((await me.json()) as { data: { email: string } }).data.email).toBe('after@example.com');
    });

    it('changes the password only with the current one (new one signs in, old one stops working)', async () => {
      const { token } = await registerUser('pwchange@example.com', 'old-password');

      const wrong = await post(
        '/change-password',
        { currentPassword: 'not-the-password', newPassword: 'new-password' },
        { authorization: `Bearer ${token}` },
      );
      expect(wrong.ok).toBe(false);

      const res = await post(
        '/change-password',
        { currentPassword: 'old-password', newPassword: 'new-password' },
        { authorization: `Bearer ${token}` },
      );
      expect(res.status).toBe(200);

      expect((await signIn('pwchange@example.com', 'new-password')).status).toBe(200);
      expect((await signIn('pwchange@example.com', 'old-password')).status).toBe(401);
    });

    it("can't change privilege fields — roleId/active aren't writable through /update-user", async () => {
      const { token, user } = await registerUser('noescalate@example.com');

      const roleId = generateId();
      const now = new Date().toISOString();
      await db.execute(sql`INSERT INTO roles (id, created_at, updated_at, name) VALUES (${roleId}, ${now}, ${now}, 'admin')`);

      await post('/update-user', { name: 'Still Me', roleId, active: false }, { authorization: `Bearer ${token}` });

      const row = (await db.execute(
        sql`SELECT role_id, active FROM users WHERE id = ${user.id}`,
      )) as unknown as { role_id: string | null; active: boolean }[];
      expect(row[0]).toEqual({ role_id: null, active: true });
    });
  });

  describe('User.operations.setPassword (admin password reset, src/auth/pipeline.ts)', () => {
    it("needs the `users:setPassword` grant, then sets a password the target user can sign in with", async () => {
      const admin = await registerUser('pw-admin@example.com');
      const target = await registerUser('pw-target@example.com');
      const call = (password: string) =>
        apiApp.request(`/users/${target.user.id}/setPassword`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({ password }),
        });

      expect((await call('admin-chosen-1')).status).toBe(403);

      await grantRole(admin.user.id as string, [{ resource: 'users', action: 'setPassword', scope: 'any' }]);
      const res = await call('admin-chosen-1');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { id: string } }).data.id).toBe(target.user.id as string);

      expect((await signIn('pw-target@example.com', 'admin-chosen-1')).status).toBe(200);
      expect((await signIn('pw-target@example.com', PW)).status).toBe(401);

      const short = await call('short');
      expect(short.status).toBe(400);
      expect(((await short.json()) as { error: { fields: Record<string, string> } }).error.fields.password).toBeTruthy();
    });

    it('creates the credential account for a user who has none (e.g. created from the console)', async () => {
      const admin = await registerUser('pw-admin2@example.com');
      await grantRole(admin.user.id as string, [{ resource: 'users', action: 'setPassword', scope: 'any' }]);
      const created = await insertRow(db, User, { email: 'no-password@example.com', name: '' });

      const res = await apiApp.request(`/users/${created.id}/setPassword`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ password: 'first-password' }),
      });
      expect(res.status).toBe(200);
      expect((await signIn('no-password@example.com', 'first-password')).status).toBe(200);
    });
  });

  describe('cookie-based session (admin SPA transport)', () => {
    function cookieFromSetHeader(res: Response): string {
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('ratchet.session_token='));
      expect(cookie).toBeTruthy();
      return cookie!.split(';')[0]!;
    }

    it('sign-in sets an HttpOnly session cookie usable in place of the Authorization header', async () => {
      await registerUser('cookie@example.com');
      const res = await signIn('cookie@example.com', PW);
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('ratchet.session_token='))!;
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      // plain http:// in tests — Secure must not be set, or the browser would drop the cookie entirely.
      expect(setCookie).not.toMatch(/Secure/i);

      const cookie = cookieFromSetHeader(res);
      const me = await authApp.request('/api/auth/me', { headers: { cookie } });
      expect(me.status).toBe(200);
      // the generic API resolves the same (signed) cookie straight from `sessions`
      const api = await apiApp.request('/roles', { headers: { cookie } });
      expect(api.status).toBe(403); // authenticated, just no `roles:read` grant
    });

    it('a Bearer header takes precedence over a cookie when both are present', async () => {
      const a = await registerUser('a@example.com');
      await registerUser('b@example.com');
      const bCookie = cookieFromSetHeader(await signIn('b@example.com', PW));

      const res = await authApp.request('/api/auth/me', { headers: { authorization: `Bearer ${a.token}`, cookie: bCookie } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { email: string } }).data.email).toBe('a@example.com');
    });

    it('sign-out works from the cookie alone and clears it', async () => {
      await registerUser('logout-cookie@example.com');
      const cookie = cookieFromSetHeader(await signIn('logout-cookie@example.com', PW));

      const signOut = await authApp.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
        body: '{}',
      });
      expect(signOut.status).toBe(200);
      const cleared = signOut.headers.getSetCookie().find((c) => c.startsWith('ratchet.session_token='))!;
      expect(cleared).toMatch(/Max-Age=0/i);

      const after = await authApp.request('/api/auth/me', { headers: { cookie } });
      expect(after.status).toBe(401);
    });
  });

  it('requirePermission wired into Role.operations: no token -> 401, wrong permission -> 403, granted permission -> 201', async () => {
    const { token, user } = await registerUser('admin@example.com');

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
      const { token } = await registerUser('models@example.com');
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

    it("strips pipeline fns/zod-schema, has no password column, and exposes setPassword's password param", async () => {
      const { token } = await registerUser('meta@example.com');
      const res = await consoleApp.request('/meta/models/users', { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json()) as {
        data: {
          fields: { key: string }[];
          operationNames: string[];
          operations: { name: string; params: { key: string; sensitive: boolean; writeAs?: string }[] }[];
        };
      };

      // passwords live in better-auth's `accounts` table, never on the user row
      expect(body.data.fields.map((f) => f.key)).not.toContain('passwordHash');
      // only serializable data crosses the wire, never a raw pipeline function
      expect(body.data.operationNames.sort()).toEqual(['create', 'remove', 'setPassword', 'update']);
      const setPassword = body.data.operations.find((o) => o.name === 'setPassword')!;
      const param = setPassword.params.find((f) => f.key === 'password')!;
      expect(param.sensitive).toBe(true);
      expect(param.writeAs).toBe('password');
    });

    it('GET /meta/models/:name 404s for a hidden model, matching an unknown model', async () => {
      const { token } = await registerUser('hidden@example.com');
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
      const a = await registerUser('owner-a@example.com');
      const b = await registerUser('owner-b@example.com');
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
      const a = await registerUser('owner-c@example.com');
      const b = await registerUser('owner-d@example.com');
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
      const a = await registerUser('owner-e@example.com');
      const b = await registerUser('owner-f@example.com');
      await grantRead(a.user.id as string, 'notes', 'any');
      await grantRead(b.user.id as string, 'notes');
      await insertRow(db, Note, { userId: a.user.id, text: 'a-note-2' });
      await insertRow(db, Note, { userId: b.user.id, text: 'b-note-2' });

      const asA = await apiApp.request('/notes', { headers: { authorization: `Bearer ${a.token}` } });
      const bodyA = (await asA.json()) as { data: { text: string }[] };
      expect(bodyA.data.map((r) => r.text).sort()).toEqual(['a-note-2', 'b-note-2']);
    });

    it("a role granted `scope: 'any'` can read a row it doesn't own by id", async () => {
      const a = await registerUser('owner-g@example.com');
      const b = await registerUser('owner-h@example.com');
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
      const { token, user } = await registerUser('lock-only@example.com');
      await grantRole(user.id as string, [{ resource: 'lockable_docs', action: 'lock', scope: 'any' }]);
      const id = await createDoc('Doc');

      const res = await apiApp.request(`/lockable_docs/${id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(400); // presetFields' own assertWriteFieldsAllowed rejects `locked`
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('the base `update` field grant alone is not enough — the operation still needs its own action grant', async () => {
      const { token, user } = await registerUser('update-only@example.com');
      await grantRole(user.id as string, [{ resource: 'lockable_docs', action: 'update', fields: ['locked'] }]);
      const id = await createDoc('Doc');

      const res = await apiApp.request(`/lockable_docs/${id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(403); // never reaches presetFields — resolveAccess denies 'lock' first
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('both grants together let the operation through and actually write the field', async () => {
      const { token, user } = await registerUser('lock-and-update@example.com');
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
      const { token, user } = await registerUser('fieldless@example.com');
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

      const { token } = await registerUser('setperms-forbidden@example.com');
      const forbidden = await apiApp.request(`/roles/${roleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: {} }),
      });
      expect(forbidden.status).toBe(403);
    });

    it("the resource-level `roles:update` grant alone is not enough — the `permissions` field grant is still required", async () => {
      const { token, user } = await registerUser('setperms-noupdate@example.com');
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
      const { token, user } = await registerUser('setperms-admin@example.com');
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
      const { token, user } = await registerUser('setperms-invalid@example.com');
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
      const { token, user } = await registerUser('setperms-wildcard@example.com');
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
      const { token, user } = await registerUser('setperms-mixed-resource@example.com');
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
      const { token, user } = await registerUser('setperms-plain-scope@example.com');
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
      const { token, user } = await registerUser('setperms-good-scope@example.com');
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
      const { token, user } = await registerUser('setperms-untouched@example.com');
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
