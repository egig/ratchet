import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { defineModel, field } from '../src/core/index.js';
import {
  allManyToManyRelationsInvolving,
  buildJunctionModel,
  findRelationsTargeting,
  junctionColumnFor,
  junctionColumns,
  junctionColumnsOf,
  manyToManyFieldsOf,
} from '../src/core/many-to-many.js';
import { buildCreateSchema, buildUpdateSchema } from '../src/core/validation.js';
import { columnKind, isFilterableOrSortable, isKnownColumn, isOperatorValidForKind } from '../src/router/fields.js';
import { allColumnKeys } from '../src/router/columns.js';
import { parseInclude, parseListQuery } from '../src/router/query.js';
import { generateSchemaSource } from '../src/codegen/schema-gen.js';
import type { ScannedModel } from '../src/codegen/scan.js';
import { createApiRouter } from '../src/router/create-router.js';

const Tag = defineModel('tags', {
  fields: { name: field.string({ required: true, indexed: true }) },
  api: { public: true },
});

const Post = defineModel('posts', {
  fields: {
    title: field.string({ required: true }),
    tags: field.manyToMany('tags'),
  },
  api: { public: true },
});

const registry = { posts: Post, tags: Tag };

describe('field.manyToMany()', () => {
  it('produces a kind: manyToMany definition with no column-backed options set', () => {
    const f = field.manyToMany('tags');
    expect(f).toMatchObject({ kind: 'manyToMany', targetModel: 'tags', required: false, unique: false, indexed: false, sensitive: false });
  });

  it('defineModel rejects a self-referential manyToMany (round 2: out of scope)', () => {
    expect(() =>
      defineModel('related_posts_fixture', {
        fields: { related: field.manyToMany('related_posts_fixture') },
      }),
    ).toThrow(/self-referential/);
  });
});

describe('core/many-to-many.ts: junction naming and synthesis', () => {
  const relation = manyToManyFieldsOf(Post)[0]!;

  it('junctionColumns is deterministic and field-key-namespaced', () => {
    expect(junctionColumns(Post, 'tags', relation.fieldDef)).toEqual({
      tableName: 'posts_tags',
      sourceColumn: 'postsId',
      targetColumn: 'tagsId',
    });
  });

  it('buildJunctionModel synthesizes a hidden model with two required, indexed references', () => {
    const junction = buildJunctionModel(relation);
    expect(junction.name).toBe('posts_tags');
    expect(junction.api).toEqual({ hidden: true });
    expect(junction.console).toEqual({ hidden: true });
    expect(junction.fields.postsId).toMatchObject({ kind: 'reference', targetModel: 'posts', required: true, indexed: true });
    expect(junction.fields.tagsId).toMatchObject({ kind: 'reference', targetModel: 'tags', required: true, indexed: true });
  });

  it('manyToManyFieldsOf finds the relation declared on Post', () => {
    const found = manyToManyFieldsOf(Post);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceModel: Post, fieldKey: 'tags' });
  });

  it('findRelationsTargeting finds Post.tags from the Tag side, with no declaration on Tag itself', () => {
    const found = findRelationsTargeting(registry, 'tags');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceModel: Post, fieldKey: 'tags' });
    expect(manyToManyFieldsOf(Tag)).toEqual([]); // Tag never declares anything of its own
  });

  it('allManyToManyRelationsInvolving finds the relation from either side', () => {
    expect(allManyToManyRelationsInvolving(registry, 'posts')).toHaveLength(1);
    expect(allManyToManyRelationsInvolving(registry, 'tags')).toHaveLength(1);
  });

  it('junctionColumnFor picks the right column per role, and rejects an unrelated model', () => {
    expect(junctionColumnFor(relation, 'posts')).toBe('postsId');
    expect(junctionColumnFor(relation, 'tags')).toBe('tagsId');
    expect(() => junctionColumnFor(relation, 'nope')).toThrow(/neither side/);
  });

  it('junctionColumnsOf agrees with junctionColumns', () => {
    expect(junctionColumnsOf(relation)).toEqual(junctionColumns(Post, 'tags', relation.fieldDef));
  });
});

describe('core/validation.ts: manyToMany schema', () => {
  it('is a required-looking-but-always-optional array of uuids on both create and update', () => {
    const create = buildCreateSchema(Post);
    expect(create.safeParse({ title: 'x' }).success).toBe(true); // tags omitted entirely -> fine
    expect(create.safeParse({ title: 'x', tags: ['00000000-0000-7000-8000-000000000000'] }).success).toBe(true);
    expect(create.safeParse({ title: 'x', tags: ['not-a-uuid'] }).success).toBe(false);

    const update = buildUpdateSchema(Post);
    expect(update.safeParse({}).success).toBe(true);
  });
});

describe('router/columns.ts + router/fields.ts: manyToMany is columnless and has-only', () => {
  it('allColumnKeys excludes a manyToMany field (no backing column)', () => {
    expect(allColumnKeys(Post)).not.toContain('tags');
    expect(allColumnKeys(Post)).toContain('title');
  });

  it('isKnownColumn is true, but isFilterableOrSortable is false (no `indexed` concept)', () => {
    expect(isKnownColumn(Post, 'tags')).toBe(true);
    expect(isFilterableOrSortable(Post, 'tags')).toBe(false);
    expect(columnKind(Post, 'tags')).toBe('manyToMany');
  });

  it('only `has` is a valid operator for a manyToMany field', () => {
    expect(isOperatorValidForKind('manyToMany', 'has')).toBe(true);
    expect(isOperatorValidForKind('manyToMany', '=')).toBe(false);
    expect(isOperatorValidForKind('manyToMany', 'in')).toBe(false);
  });
});

describe('router/query.ts: include + filter parsing', () => {
  it('parseInclude accepts the forward name (declared field key)', () => {
    expect(parseInclude(Post, 'tags', registry)).toEqual(['tags']);
  });

  it('parseInclude accepts the reverse name (the declaring model\'s own name) with no declaration on Tag', () => {
    expect(parseInclude(Tag, 'posts', registry)).toEqual(['posts']);
  });

  it('parseInclude rejects an unrelated name', () => {
    expect(() => parseInclude(Post, 'nonsense', registry)).toThrow();
  });

  it('parseListQuery accepts a structured `has` filter on a manyToMany field', () => {
    const params = new URLSearchParams({ filter: JSON.stringify([['tags', 'has', '00000000-0000-7000-8000-000000000000']]) });
    const query = parseListQuery(Post, params, registry);
    expect(query.filters).toEqual([{ field: 'tags', op: 'has', value: '00000000-0000-7000-8000-000000000000' }]);
  });

  it('rejects a bare ?tags=x query param instead of silently building a broken `=` filter', () => {
    const params = new URLSearchParams({ tags: 'some-id' });
    try {
      parseListQuery(Post, params, registry);
      expect.unreachable('expected parseListQuery to throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_OPERATOR');
      expect(JSON.stringify((err as { fields?: unknown }).fields)).toMatch(/structured filter syntax/);
    }
  });
});

describe('codegen/schema-gen.ts: junction table emission', () => {
  it('emits a junction table with a compound partial-unique index, and no `tags` column on posts itself', () => {
    const scanned: ScannedModel[] = [
      { filePath: '/fake/post.model.ts', exportName: 'Post', model: Post },
      { filePath: '/fake/tag.model.ts', exportName: 'Tag', model: Tag },
    ];
    const src = generateSchemaSource(scanned, 'postgres');

    expect(src).toContain("pgTable('posts_tags'");
    expect(src).toContain('postsId: uuid');
    expect(src).toContain('tagsId: uuid');
    expect(src).toContain("uniqueIndex('posts_tags_unique_idx').on(table.postsId, table.tagsId)");
    expect(src).toContain('.where(sql`${table.deletedAt} IS NULL`)');

    // the posts table itself must not gain a `tags` column — the relation is virtual.
    const postsTableSrc = src.slice(src.indexOf("pgTable('posts'"), src.indexOf("pgTable('posts_tags'"));
    expect(postsTableSrc).not.toMatch(/\n\s*tags:/);
  });
});

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('manyToMany end-to-end (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let app: ReturnType<typeof createApiRouter>;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tags (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS posts (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        title varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS posts_tags (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        posts_id uuid NOT NULL, tags_id uuid NOT NULL
      )`);
    app = createApiRouter(registry, db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE posts_tags, posts, tags`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS posts_tags`);
    await db.execute(sql`DROP TABLE IF EXISTS posts`);
    await db.execute(sql`DROP TABLE IF EXISTS tags`);
    await client.end();
  });

  async function createTag(name: string): Promise<string> {
    const res = await app.request('/tags', { method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' } });
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it('POST /posts with tags: [...] creates the row and its junction rows', async () => {
    const [t1, t2] = await Promise.all([createTag('typescript'), createTag('postgres')]);
    const res = await app.request('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Hello', tags: [t1, t2] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const post = ((await res.json()) as { data: { id: string } }).data;

    const get = await app.request(`/posts/${post.id}?include=tags`);
    const body = (await get.json()) as { data: { tags: { id: string; name: string }[] } };
    expect(body.data.tags.map((t) => t.name).sort()).toEqual(['postgres', 'typescript']);

    const junctionRows = await db.execute(sql`SELECT * FROM posts_tags WHERE posts_id = ${post.id}`);
    expect((junctionRows as unknown as unknown[]).length).toBe(2);
  });

  it('PATCH /posts/:id with a new tags: [...] replaces the set (add + remove in one call)', async () => {
    const [t1, t2, t3] = await Promise.all([createTag('a'), createTag('b'), createTag('c')]);
    const created = await app.request('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'X', tags: [t1, t2] }),
      headers: { 'content-type': 'application/json' },
    });
    const post = ((await created.json()) as { data: { id: string } }).data;

    await app.request(`/posts/${post.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ tags: [t2, t3] }), // drop t1, keep t2, add t3
      headers: { 'content-type': 'application/json' },
    });

    const get = await app.request(`/posts/${post.id}?include=tags`);
    const body = (await get.json()) as { data: { tags: { name: string }[] } };
    expect(body.data.tags.map((t) => t.name).sort()).toEqual(['b', 'c']);
  });

  it('?include=posts works from the Tag side with no declaration on Tag', async () => {
    const t1 = await createTag('shared');
    await app.request('/posts', { method: 'POST', body: JSON.stringify({ title: 'One', tags: [t1] }), headers: { 'content-type': 'application/json' } });
    await app.request('/posts', { method: 'POST', body: JSON.stringify({ title: 'Two', tags: [t1] }), headers: { 'content-type': 'application/json' } });

    const res = await app.request(`/tags/${t1}?include=posts`);
    const body = (await res.json()) as { data: { posts: { title: string }[] } };
    expect(body.data.posts.map((p) => p.title).sort()).toEqual(['One', 'Two']);
  });

  it('?filter=[["tags","has",id]] narrows posts to ones carrying that tag', async () => {
    const [wanted, other] = await Promise.all([createTag('wanted'), createTag('other')]);
    await app.request('/posts', { method: 'POST', body: JSON.stringify({ title: 'Match', tags: [wanted] }), headers: { 'content-type': 'application/json' } });
    await app.request('/posts', { method: 'POST', body: JSON.stringify({ title: 'NoMatch', tags: [other] }), headers: { 'content-type': 'application/json' } });

    const res = await app.request(`/posts?filter=${encodeURIComponent(JSON.stringify([['tags', 'has', wanted]]))}`);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((p) => p.title)).toEqual(['Match']);
  });

  it('soft-removing a Tag cascades to soft-remove its junction rows', async () => {
    const t1 = await createTag('doomed');
    const created = await app.request('/posts', {
      method: 'POST',
      body: JSON.stringify({ title: 'X', tags: [t1] }),
      headers: { 'content-type': 'application/json' },
    });
    const post = ((await created.json()) as { data: { id: string } }).data;

    await app.request(`/tags/${t1}`, { method: 'DELETE' });

    const rows = (await db.execute(sql`SELECT deleted_at FROM posts_tags WHERE posts_id = ${post.id}`)) as unknown as { deleted_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();

    const get = await app.request(`/posts/${post.id}?include=tags`);
    const body = (await get.json()) as { data: { tags: unknown[] } };
    expect(body.data.tags).toEqual([]); // the soft-deleted tag no longer surfaces
  });

  it('the junction table has no API of its own — /api/posts_tags is unreachable (round 5: no direct access)', async () => {
    const res = await app.request('/posts_tags');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('MODEL_NOT_FOUND');
  });
});
