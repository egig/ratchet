import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { defineModel, field } from '../src/core/index.js';
import { generateId } from '../src/core/id.js';
import { hashPassword } from '../src/auth/password.js';
import { insertSession } from '../src/auth/lookup.js';
import { generateToken, sessionExpiry } from '../src/auth/token.js';
import { resolveAgentTools, executeAgentTool } from '../src/automation/tool.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

// An agent's tools are derived from whichever `Role` its `roleId` points at (src/auth/models/
// role.model.ts's `permissions` array), not a dedicated `AgentPermission` junction table — see
// src/automation/tool.ts's `resolveAgentTools`. This suite exercises that resolution plus
// `executeAgentTool`'s own re-check against the *chatting user's* role (never the agent's role
// alone) directly, without needing a live `Agent`/`Provider`/`Chat` row — `resolveAgentTools`
// takes a bare `roleId`.
describeIfDb('agent tools are role-derived (src/automation/tool.ts)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  const Gizmo = defineModel('gizmos', {
    fields: {
      name: field.string({ required: true, indexed: true }),
    },
  });

  const registry = { gizmos: Gizmo };

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, description text, workspace_template_id uuid, permissions jsonb NOT NULL DEFAULT '[]'
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
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS gizmos (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL
      )`);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE gizmos, sessions, users, roles`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS gizmos`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS users`);
    await db.execute(sql`DROP TABLE IF EXISTS roles`);
    await client.end();
  });

  async function createRole(permissions: unknown[]): Promise<string> {
    const roleId = generateId();
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions)
          VALUES (${roleId}, ${now}, ${now}, ${`role-${roleId}`}, ${JSON.stringify(permissions)})`,
    );
    return roleId;
  }

  async function createSessionUser(roleId: string | null): Promise<{ id: string; token: string }> {
    const id = generateId();
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO users (id, created_at, updated_at, email, password_hash, role_id)
          VALUES (${id}, ${now}, ${now}, ${`user-${id}@example.com`}, ${await hashPassword('pw')}, ${roleId})`,
    );
    const token = generateToken();
    const now2 = new Date();
    await insertSession(db, generateId(), id, token, sessionExpiry(now2), now2);
    return { id, token };
  }

  function requestAs(token: string): Request {
    return new Request('http://localhost/', { headers: { authorization: `Bearer ${token}` } });
  }

  describe('resolveAgentTools', () => {
    it('a role granting create_<x> offers exactly that tool', async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'create', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      expect(tools.map((t) => t.spec.name)).toEqual(['create_gizmos']);
    });

    it('no role (null) offers no tools at all', async () => {
      expect(await resolveAgentTools(db, registry, null)).toEqual([]);
    });

    it('a role with an empty permissions array offers no tools', async () => {
      const roleId = await createRole([]);
      expect(await resolveAgentTools(db, registry, roleId)).toEqual([]);
    });

    it("action: '*' expands to every builtin operation (reads + writes) on the granted resource", async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: '*', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      expect(tools.map((t) => t.spec.name).sort()).toEqual([
        'create_gizmos',
        'findOne_gizmos',
        'list_gizmos',
        'remove_gizmos',
        'update_gizmos',
      ]);
    });

    it("action: 'read' offers exactly the list_/findOne_ read tools", async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      expect(tools.map((t) => t.spec.name).sort()).toEqual(['findOne_gizmos', 'list_gizmos']);
    });

    it("the list tool's parameters expose filter/sort/pagination", async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      const list = tools.find((t) => t.spec.name === 'list_gizmos')!;
      const params = list.spec.parameters as { type?: string; properties?: Record<string, unknown> };
      expect(params.type).toBe('object');
      expect(Object.keys(params.properties ?? {}).sort()).toEqual(['filters', 'include', 'limit', 'offset', 'sort']);
    });

    // Guards against a schema-library regression: the tool's `parameters` must be a real JSON
    // Schema object describing the model's fields, not an empty/degenerate document — a chatting
    // model can't call the tool correctly otherwise.
    it("a tool's parameters is a proper JSON Schema of the model's fields", async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'create', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      const params = tools[0]!.spec.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(params.type).toBe('object');
      expect(params.properties).toEqual({ name: { type: 'string' } });
      expect(params.required).toEqual(['name']);
    });
  });

  describe('executeAgentTool — the chatting user\'s own role gates the actual call, never the agent\'s alone', () => {
    it("403s when the chatting user's own role lacks the grant, even though the agent's role has it", async () => {
      const agentRoleId = await createRole([{ resource: 'gizmos', action: 'create', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, agentRoleId);
      const tool = tools.find((t) => t.spec.name === 'create_gizmos')!;

      // narrower than the agent's own role: no role at all.
      const chattingUser = await createSessionUser(null);

      await expect(
        executeAgentTool(tool, { name: 'widget' }, { db, request: requestAs(chattingUser.token), registry }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("succeeds when the chatting user's own role also grants it, and actually writes the row", async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'create', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      const tool = tools.find((t) => t.spec.name === 'create_gizmos')!;

      const chattingUser = await createSessionUser(roleId);

      const result = (await executeAgentTool(tool, { name: 'widget' }, { db, request: requestAs(chattingUser.token), registry })) as Record<
        string,
        unknown
      >;
      expect(result.name).toBe('widget');
    });

    it('401s with no session at all', async () => {
      const roleId = await createRole([{ resource: 'gizmos', action: 'create', field: '*' }]);
      const tools = await resolveAgentTools(db, registry, roleId);
      const tool = tools.find((t) => t.spec.name === 'create_gizmos')!;

      await expect(
        executeAgentTool(tool, { name: 'widget' }, { db, request: new Request('http://localhost/'), registry }),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('executeAgentTool — builtin read tools (list / findOne)', () => {
    async function insertGizmo(name: string): Promise<string> {
      const id = generateId();
      const now = new Date().toISOString();
      await db.execute(
        sql`INSERT INTO gizmos (id, created_at, updated_at, name) VALUES (${id}, ${now}, ${now}, ${name})`,
      );
      return id;
    }

    async function toolsFor(roleId: string, name: string) {
      const tools = await resolveAgentTools(db, registry, roleId);
      return tools.find((t) => t.spec.name === name)!;
    }

    it('list_ returns the rows in a { data, meta } envelope', async () => {
      await insertGizmo('alpha');
      await insertGizmo('beta');
      const roleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const chattingUser = await createSessionUser(roleId);
      const tool = await toolsFor(roleId, 'list_gizmos');

      const result = (await executeAgentTool(tool, {}, { db, request: requestAs(chattingUser.token), registry })) as {
        data: Record<string, unknown>[];
        meta: { total: number };
      };
      expect(result.meta.total).toBe(2);
      expect(result.data.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
    });

    it('list_ applies filters through the same parser the REST route uses', async () => {
      await insertGizmo('keep');
      await insertGizmo('drop');
      const roleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const chattingUser = await createSessionUser(roleId);
      const tool = await toolsFor(roleId, 'list_gizmos');

      const result = (await executeAgentTool(
        tool,
        { filters: [{ field: 'name', op: '=', value: 'keep' }] },
        { db, request: requestAs(chattingUser.token), registry },
      )) as { data: Record<string, unknown>[] };
      expect(result.data.map((r) => r.name)).toEqual(['keep']);
    });

    it('findOne_ returns a single row by id, 404s for an unknown id', async () => {
      const id = await insertGizmo('solo');
      const roleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const chattingUser = await createSessionUser(roleId);
      const tool = await toolsFor(roleId, 'findOne_gizmos');

      const row = (await executeAgentTool(tool, { id }, { db, request: requestAs(chattingUser.token), registry })) as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('solo');

      await expect(
        executeAgentTool(tool, { id: generateId() }, { db, request: requestAs(chattingUser.token), registry }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("the chatting user's own role gates the read — 403 when they lack the read grant the agent has", async () => {
      await insertGizmo('secret');
      const agentRoleId = await createRole([{ resource: 'gizmos', action: 'read', field: '*' }]);
      const tool = await toolsFor(agentRoleId, 'list_gizmos');
      const chattingUser = await createSessionUser(null);

      await expect(
        executeAgentTool(tool, {}, { db, request: requestAs(chattingUser.token), registry }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('field-level read grant scopes which columns come back', async () => {
      await insertGizmo('visible-name');
      // read granted, but no `field` grant at all → zero model fields (id/timestamps only).
      const roleId = await createRole([{ resource: 'gizmos', action: 'read' }]);
      const chattingUser = await createSessionUser(roleId);
      const tool = await toolsFor(roleId, 'list_gizmos');

      const result = (await executeAgentTool(tool, {}, { db, request: requestAs(chattingUser.token), registry })) as {
        data: Record<string, unknown>[];
      };
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.name).toBeUndefined();
      expect(result.data[0]!.id).toBeDefined();
    });

    it('rejects ?filter/?sort on a field the role cannot read', async () => {
      await insertGizmo('x');
      const roleId = await createRole([{ resource: 'gizmos', action: 'read' }]);
      const chattingUser = await createSessionUser(roleId);
      const tool = await toolsFor(roleId, 'list_gizmos');

      await expect(
        executeAgentTool(
          tool,
          { filters: [{ field: 'name', op: '=', value: 'x' }] },
          { db, request: requestAs(chattingUser.token), registry },
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
