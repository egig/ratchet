import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import type { CustomOperationDefinition, OperationContext } from '../src/core/index.js';
import { generateId } from '../src/core/id.js';
import { insertRow } from '../src/core/persistence.js';
import { WorkTitle } from '../src/workspace/models/work-title.model.js';
import { Workspace, WorkspaceView, requireNotLocked, forbidLockedInUpdate } from '../src/workspace/models/index.js';
import { assertOwnsWorkspace, requireWorkspaceOwnership } from '../src/workspace/pipeline.js';
import { createDefaultWorkspace, DEFAULT_WORKSPACE_NAME } from '../src/workspace/provisioning.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describe('Workspace fields (src/workspace/models/workspace.model.ts)', () => {
  it('has a `chatEnabled` boolean defaulting to true — the console gate for the agent chat panel', () => {
    const f = Workspace.fields.chatEnabled;
    expect(f?.kind).toBe('boolean');
    expect(f?.default).toBe(true);
  });
});

describe('assertOwnsWorkspace (src/workspace/pipeline.ts)', () => {
  it('passes for a workspace owned by the given user', () => {
    expect(() => assertOwnsWorkspace({ userId: 'u1' }, { id: 'u1' } as never)).not.toThrow();
  });

  it('404s for a workspace owned by someone else', () => {
    expect(() => assertOwnsWorkspace({ userId: 'u1' }, { id: 'u2' } as never)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
  });

  it('404s (not a leakier error) when the workspace is null — "not found", not "not yours"', () => {
    expect(() => assertOwnsWorkspace(null, { id: 'u1' } as never)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
  });
});

describe('requireNotLocked (src/workspace/models/workspace.model.ts)', () => {
  it('passes when the doc is not locked', () => {
    const ctx = { doc: { locked: false }, input: { name: 'x' } } as never;
    expect(requireNotLocked(ctx)).toBe(ctx);
  });

  it('passes when the doc has no locked field at all', () => {
    const ctx = { doc: {}, input: { name: 'x' } } as never;
    expect(requireNotLocked(ctx)).toBe(ctx);
  });

  it('throws FORBIDDEN for any write to a locked doc — no carve-out anymore, since unlocking is the `unlock` operation, not a plain update', () => {
    expect(() => requireNotLocked({ doc: { locked: true }, input: { name: 'x' } } as never)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    );
    expect(() => requireNotLocked({ doc: { locked: true }, input: {} } as never)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    );
  });
});

describe('forbidLockedInUpdate (src/workspace/models/workspace.model.ts)', () => {
  it('passes an update that never touches `locked`', () => {
    const ctx = { input: { name: 'x' } } as never;
    expect(forbidLockedInUpdate(ctx)).toBe(ctx);
  });

  it("rejects `locked` in the update body, even alongside other fields — that's what `lock`/`unlock` are for", () => {
    expect(() => forbidLockedInUpdate({ input: { locked: true } } as never)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
    expect(() => forbidLockedInUpdate({ input: { name: 'x', locked: false } } as never)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
  });
});

describeIfDb('requireWorkspaceOwnership (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  // No beforeEach TRUNCATE / afterAll DROP here: `workspaces`/`workspace_views` are also written
  // by `auth.test.ts` (register/setup now provision a default `Workspace`, `workspace/
  // provisioning.ts`) and this file's own `createDefaultWorkspace` suite below — vitest runs test
  // *files* in parallel against the same live DB, so truncating/dropping a table another file is
  // mid-use of races it (see auth.test.ts's own note on `users`/`sessions` for the same issue).
  // Every test below is scoped to its own freshly generated ids, so an unclean table is harmless.
  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, name varchar NOT NULL, locked boolean NOT NULL DEFAULT false,
        chat_enabled boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspace_views (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, workspace_id uuid NOT NULL, target_model varchar NOT NULL, label varchar NOT NULL,
        filters jsonb, sort jsonb, include jsonb,
        "limit" integer NOT NULL DEFAULT 20, "order" integer NOT NULL DEFAULT 0
      )`);
  });

  afterAll(async () => {
    await client.end();
  });

  function ctxFor(userId: string, workspaceId: string | undefined): OperationContext {
    return {
      operation: 'create',
      input: workspaceId ? { workspaceId } : {},
      doc: null,
      model: WorkspaceView,
      db,
      user: { id: userId },
    };
  }

  it('passes when the workspaceId belongs to the requesting user', async () => {
    const userA = generateId();
    const workspace = await insertRow(db, Workspace, { userId: userA, name: 'Mine' });

    await expect(requireWorkspaceOwnership(ctxFor(userA, workspace.id as string))).resolves.toBeDefined();
  });

  it("404s when the workspaceId belongs to a different user (stops a view attaching to someone else's workspace)", async () => {
    const userA = generateId();
    const userB = generateId();
    const workspace = await insertRow(db, Workspace, { userId: userA, name: 'Mine' });

    await expect(requireWorkspaceOwnership(ctxFor(userB, workspace.id as string))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('404s when the workspaceId does not exist', async () => {
    const userA = generateId();
    await expect(
      requireWorkspaceOwnership(ctxFor(userA, '00000000-0000-7000-8000-000000000000')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('is a no-op when there is no workspaceId to check (e.g. an update not touching it)', async () => {
    const userA = generateId();
    const ctx = ctxFor(userA, undefined);
    await expect(requireWorkspaceOwnership(ctx)).resolves.toBe(ctx);
  });

  it("403s (not 404) when the workspace is locked, even though the requester owns it — blocks a WorkspaceView write against a locked workspace", async () => {
    const userA = generateId();
    const workspace = await insertRow(db, Workspace, { userId: userA, name: 'Locked', locked: true });

    await expect(requireWorkspaceOwnership(ctxFor(userA, workspace.id as string))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});

describeIfDb('Workspace lock/unlock (custom operations, src/workspace/models/workspace.model.ts)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  // Shared `workspaces` table, same reasoning as `requireWorkspaceOwnership` above — no
  // beforeEach TRUNCATE / afterAll DROP; every test is scoped to its own freshly generated ids.
  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, name varchar NOT NULL, locked boolean NOT NULL DEFAULT false,
        chat_enabled boolean NOT NULL DEFAULT true
      )`);
    // `presetFields` (inside `lock`/`unlock`) checks the caller's *field* grant on `update` via
    // `resolveGrantedFields` — a real DB lookup by `roleId`, independent of `requireOwnsRow`'s own
    // ownership check — so this suite needs a `roles` fixture too, shared with
    // `auth.test.ts`/`router.test.ts`'s own copy the same idempotent way `workspaces` already is.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS roles (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, description text, permissions jsonb NOT NULL DEFAULT '[]'
      )`);
  });

  afterAll(async () => {
    await client.end();
  });

  // `lock`/`unlock` are `CustomOperationDefinition` objects (they carry a `console` block), not
  // bare `PipelineFn`s — `.pipeline` is what's actually callable, same as `create-router.ts`'s
  // own dispatch (`typeof entry === 'function' ? entry : entry.pipeline`).
  function operationPipeline(name: 'lock' | 'unlock') {
    return (Workspace.operations[name] as CustomOperationDefinition).pipeline;
  }

  /** A role granted `workspaces:update` field access to `locked` — what `presetFields` itself
   * checks (Q4/Q10's second gate); the *first* gate (`resource:lock`/`resource:unlock`) is the
   * router's own job (`create-router.ts`'s `resolveAccess`), already covered end-to-end by
   * `auth.test.ts`'s "two independent permission gates" suite, so this file only needs the
   * field-grant half to exercise `Workspace`'s own pipeline composition in isolation. */
  async function roleWithLockedFieldGrant(): Promise<string> {
    const roleId = generateId();
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO roles (id, created_at, updated_at, name, permissions)
          VALUES (${roleId}, ${now}, ${now}, ${`role-${roleId}`}, ${JSON.stringify([{ resource: 'workspaces', action: 'update', field: 'locked' }])})`,
    );
    return roleId;
  }

  function opCtx(operation: string, id: string, userId: string, roleId: string | null): OperationContext {
    return { operation, id, input: {}, doc: null, model: Workspace, db, user: { id: userId, roleId } };
  }

  it('the owner can lock and then unlock their own workspace once their role grants `update`+`locked`', async () => {
    const userId = generateId();
    const roleId = await roleWithLockedFieldGrant();
    const workspace = await insertRow(db, Workspace, { userId, name: 'Mine' });

    const locked = await operationPipeline('lock')(opCtx('lock', workspace.id as string, userId, roleId));
    expect(locked.doc?.locked).toBe(true);

    const unlocked = await operationPipeline('unlock')(opCtx('unlock', workspace.id as string, userId, roleId));
    expect(unlocked.doc?.locked).toBe(false);
  });

  it("rejects the write when the owner's role has no `locked` field grant, even though they own the row", async () => {
    const userId = generateId();
    const workspace = await insertRow(db, Workspace, { userId, name: 'Mine' });

    await expect(operationPipeline('lock')(opCtx('lock', workspace.id as string, userId, null))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it("404s (not a leakier error) when a non-owner tries to lock someone else's workspace, and doesn't write anything", async () => {
    const ownerId = generateId();
    const otherId = generateId();
    const workspace = await insertRow(db, Workspace, { userId: ownerId, name: 'Mine' });

    await expect(operationPipeline('lock')(opCtx('lock', workspace.id as string, otherId, null))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });

    const row = await db.execute(sql`SELECT locked FROM workspaces WHERE id = ${workspace.id}`);
    expect((row as unknown as { locked: boolean }[])[0]?.locked).toBe(false);
  });

  it("update rejects a `locked` key outright — locking/unlocking only happens through the dedicated operations", async () => {
    const userId = generateId();
    const workspace = await insertRow(db, Workspace, { userId, name: 'Mine' });

    const ctx: OperationContext = {
      operation: 'update',
      id: workspace.id as string,
      input: { locked: true },
      doc: null,
      model: Workspace,
      db,
      user: { id: userId, roleId: null },
    };
    await expect(Workspace.operations.update(ctx)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});

describeIfDb('createDefaultWorkspace (src/workspace/provisioning.ts, against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    // `workspaces`/`workspace_views` are shared with `auth.test.ts` and the
    // `requireWorkspaceOwnership` suite above (see that suite's note) — not truncated/dropped
    // here either. `work_titles` is exclusive to this file, so it's safe to reset between tests.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspaces (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, name varchar NOT NULL, locked boolean NOT NULL DEFAULT false,
        chat_enabled boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS workspace_views (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, workspace_id uuid NOT NULL, target_model varchar NOT NULL, label varchar NOT NULL,
        filters jsonb, sort jsonb, include jsonb,
        "limit" integer NOT NULL DEFAULT 20, "order" integer NOT NULL DEFAULT 0
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS work_titles (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, rank integer NOT NULL, workspace_template_id uuid NOT NULL
      )`);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE work_titles`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS work_titles`);
    await client.end();
  });

  function ctxForNewUser(userId: string, workTitleId?: string): OperationContext {
    return {
      operation: 'create',
      input: {},
      doc: workTitleId ? { id: userId, workTitleId } : { id: userId },
      model: Workspace,
      db,
    };
  }

  it('provisions a blank "My Workspace" for a user with no workTitleId', async () => {
    const userId = generateId();
    await createDefaultWorkspace(ctxForNewUser(userId));

    const workspaces = await db.execute(sql`SELECT name, user_id FROM workspaces WHERE user_id = ${userId}`);
    expect(workspaces).toEqual([{ name: DEFAULT_WORKSPACE_NAME, user_id: userId }]);
  });

  it("clones the work title's template workspace tabs into a new workspace owned by the user", async () => {
    const templateOwnerId = generateId();
    const template = await insertRow(db, Workspace, { userId: templateOwnerId, name: 'Sales Template' });
    await insertRow(db, WorkspaceView, {
      userId: templateOwnerId,
      workspaceId: template.id,
      targetModel: 'leads',
      label: 'My Leads',
      filters: [['status', '=', 'open']],
      sort: [{ field: 'createdAt', direction: 'desc' }],
      order: 0,
    });
    await insertRow(db, WorkspaceView, {
      userId: templateOwnerId,
      workspaceId: template.id,
      targetModel: 'deals',
      label: 'Pipeline',
      order: 1,
    });
    const workTitle = await insertRow(db, WorkTitle, { name: 'Sales Rep', rank: 2, workspaceTemplateId: template.id });

    const newUserId = generateId();
    await createDefaultWorkspace(ctxForNewUser(newUserId, workTitle.id as string));

    const workspaces = (await db.execute(
      sql`SELECT id, name FROM workspaces WHERE user_id = ${newUserId}`,
    )) as unknown as { id: string; name: string }[];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe('Sales Rep');

    const views = (await db.execute(
      sql`SELECT target_model, label, user_id, workspace_id FROM workspace_views WHERE workspace_id = ${workspaces[0]!.id} ORDER BY "order"`,
    )) as unknown as { target_model: string; label: string; user_id: string; workspace_id: string }[];
    expect(views).toEqual([
      { target_model: 'leads', label: 'My Leads', user_id: newUserId, workspace_id: workspaces[0]!.id },
      { target_model: 'deals', label: 'Pipeline', user_id: newUserId, workspace_id: workspaces[0]!.id },
    ]);

    // the template itself is untouched — still one workspace, still owned by its original creator.
    const templateViews = await db.execute(sql`SELECT id FROM workspace_views WHERE workspace_id = ${template.id}`);
    expect(templateViews).toHaveLength(2);
  });

  it('is a no-op when ctx.doc has no id (nothing to provision for)', async () => {
    // `workspaces` is shared with other suites running concurrently (see the beforeAll note
    // above), so this checks the row count doesn't change rather than asserting the table is
    // empty.
    const before = (await db.execute(sql`SELECT count(*)::int AS count FROM workspaces`)) as unknown as {
      count: number;
    }[];
    const ctx: OperationContext = { operation: 'create', input: {}, doc: null, model: Workspace, db };
    await createDefaultWorkspace(ctx);
    const after = (await db.execute(sql`SELECT count(*)::int AS count FROM workspaces`)) as unknown as {
      count: number;
    }[];
    expect(after[0]!.count).toBe(before[0]!.count);
  });
});
