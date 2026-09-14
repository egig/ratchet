import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { sql } from 'drizzle-orm';
import { defineModel, field, persist } from '../src/core/index.js';
import { treeFieldOf, wouldCreateTreeCycle } from '../src/core/tree.js';
import { buildCreateSchema, buildUpdateSchema } from '../src/core/validation.js';
import { createApiRouter } from '../src/router/create-router.js';

describe('field.tree()', () => {
  it('produces a kind: tree definition — never required/unique, targetModel unresolved until defineModel()', () => {
    const f = field.tree({ indexed: true, displayText: 'Parent' });
    expect(f).toMatchObject({
      kind: 'tree',
      targetModel: '',
      required: false,
      unique: false,
      indexed: true,
      displayText: 'Parent',
    });
  });
});

describe('defineModel: field.tree() constraints', () => {
  it("resolves targetModel to the declaring model's own name", () => {
    const Category = defineModel('tree_fixture_categories', {
      fields: { name: field.string({ required: true }), parentId: field.tree() },
    });
    expect(Category.fields.parentId).toMatchObject({ kind: 'tree', targetModel: 'tree_fixture_categories' });
  });

  it("rejects a tree field key not ending in 'Id'", () => {
    expect(() => defineModel('tree_fixture_bad_key', { fields: { parent: field.tree() } })).toThrow(
      /must have a key ending in 'Id'/,
    );
  });

  it('rejects a second field.tree() declared on the same model', () => {
    expect(() =>
      defineModel('tree_fixture_two_trees', {
        fields: { parentId: field.tree(), altParentId: field.tree() },
      }),
    ).toThrow(/only one field\.tree\(\) is supported per model/);
  });
});

describe('core/tree.ts: treeFieldOf', () => {
  it("finds a model's declared tree field", () => {
    const Category = defineModel('tree_fixture_lookup', {
      fields: { parentId: field.tree() },
    });
    expect(treeFieldOf(Category)).toMatchObject({ key: 'parentId', fieldDef: { kind: 'tree' } });
  });

  it('returns undefined for a model with no tree field', () => {
    const Widget = defineModel('tree_fixture_no_tree', { fields: { name: field.string() } });
    expect(treeFieldOf(Widget)).toBeUndefined();
  });
});

describe('validation: tree field schema', () => {
  const Category = defineModel('tree_fixture_validation', {
    fields: { name: field.string({ required: true }), parentId: field.tree() },
  });

  it('create: parentId may be omitted, null, or a uuid — never a non-uuid string', () => {
    const schema = buildCreateSchema(Category);
    expect(schema.safeParse({ name: 'root' }).success).toBe(true);
    expect(schema.safeParse({ name: 'root', parentId: null }).success).toBe(true);
    expect(schema.safeParse({ name: 'child', parentId: '00000000-0000-7000-8000-000000000000' }).success).toBe(true);
    expect(schema.safeParse({ name: 'child', parentId: 'not-a-uuid' }).success).toBe(false);
  });

  it('update: same nullable-uuid shape, also optional (PATCH-shaped)', () => {
    const schema = buildUpdateSchema(Category);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ parentId: null }).success).toBe(true);
    expect(schema.safeParse({ parentId: 'nope' }).success).toBe(false);
  });
});

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const Category = defineModel('tree_test_categories', {
  fields: {
    name: field.string({ required: true, indexed: true }),
    parentId: field.tree({ indexed: true }),
  },
  api: { public: true },
});

const registry = { tree_test_categories: Category };

describeIfDb('field.tree() end-to-end (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let app: ReturnType<typeof createApiRouter>;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tree_test_categories (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL,
        parent_id uuid REFERENCES tree_test_categories(id)
      )`);
    app = createApiRouter(registry, db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE tree_test_categories`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS tree_test_categories`);
    await client.end();
  });

  async function createCategory(name: string, parentId: string | null = null): Promise<{ id: string }> {
    const res = await app.request('/tree_test_categories', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
      headers: { 'content-type': 'application/json' },
    });
    return ((await res.json()) as { data: { id: string } }).data;
  }

  it('a category created with no parentId is a root (null)', async () => {
    const res = await app.request('/tree_test_categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Assets' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { parentId: string | null } };
    expect(body.data.parentId).toBeNull();
  });

  it('?include=parent embeds the parent row on a child', async () => {
    const assets = await createCategory('Assets');
    const cash = await createCategory('Cash', assets.id);

    const res = await app.request(`/tree_test_categories/${cash.id}?include=parent`);
    const body = (await res.json()) as { data: { parentId: string; parent: { id: string; name: string } } };
    expect(body.data.parentId).toBe(assets.id);
    expect(body.data.parent).toMatchObject({ id: assets.id, name: 'Assets' });
  });

  it('PATCH parentId: null promotes a child back to a root node', async () => {
    const assets = await createCategory('Assets');
    const cash = await createCategory('Cash', assets.id);

    const patch = await app.request(`/tree_test_categories/${cash.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: null }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.status).toBe(200);

    const get = await app.request(`/tree_test_categories/${cash.id}`);
    const body = (await get.json()) as { data: { parentId: string | null } };
    expect(body.data.parentId).toBeNull();
  });

  it('rejects setting a node as its own parent (immediate cycle) with TREE_CYCLE', async () => {
    const root = await createCategory('Root');

    const res = await app.request(`/tree_test_categories/${root.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: root.id }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; fields?: Record<string, string> } };
    expect(body.error.code).toBe('TREE_CYCLE');
    expect(body.error.fields?.parentId).toBeTruthy();
  });

  it('rejects reparenting a node under its own descendant (deep cycle)', async () => {
    const grandparent = await createCategory('Assets');
    const parent = await createCategory('Current Assets', grandparent.id);
    const child = await createCategory('Cash', parent.id);

    // Assets -> Cash would make Assets a descendant of its own descendant.
    const res = await app.request(`/tree_test_categories/${grandparent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: child.id }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TREE_CYCLE');

    // the original chain is untouched — the rejected write never landed.
    const get = await app.request(`/tree_test_categories/${grandparent.id}`);
    const getBody = (await get.json()) as { data: { parentId: string | null } };
    expect(getBody.data.parentId).toBeNull();
  });

  it('reparenting under an unrelated node (not an ancestor/descendant) is allowed', async () => {
    const a = await createCategory('A');
    const b = await createCategory('B');

    const res = await app.request(`/tree_test_categories/${b.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId: a.id }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('?filter=[["parentId","=",id]] finds direct children only', async () => {
    const assets = await createCategory('Assets');
    const cash = await createCategory('Cash', assets.id);
    await createCategory('Grandchild', cash.id);

    const res = await app.request(
      `/tree_test_categories?filter=${encodeURIComponent(JSON.stringify([['parentId', '=', assets.id]]))}`,
    );
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data.map((c) => c.name)).toEqual(['Cash']);
  });

  it('?filter=[["parentId","is",null]] finds root nodes', async () => {
    const root = await createCategory('Root');
    await createCategory('Child', root.id);

    const res = await app.request(
      `/tree_test_categories?filter=${encodeURIComponent(JSON.stringify([['parentId', 'is', null]]))}`,
    );
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data.map((c) => c.name)).toEqual(['Root']);
  });

  it('hard-deleting a category with an existing child is blocked by the FK (RESTRICT)', async () => {
    const parent = await createCategory('Parent');
    await createCategory('Child', parent.id);

    await expect(
      persist.hardRemove({ operation: 'remove', id: parent.id, input: {}, doc: null, model: Category, db }),
    ).rejects.toThrow();
  });

  it('wouldCreateTreeCycle: true for self, true for an ancestor, false for an unrelated node', async () => {
    const a = await createCategory('A');
    const b = await createCategory('B', a.id);
    const c = await createCategory('C');

    expect(await wouldCreateTreeCycle(db, Category, 'parentId', a.id, a.id)).toBe(true); // self
    expect(await wouldCreateTreeCycle(db, Category, 'parentId', a.id, b.id)).toBe(true); // descendant
    expect(await wouldCreateTreeCycle(db, Category, 'parentId', a.id, c.id)).toBe(false); // unrelated
  });
});
