import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { defineModel, field } from '../src/core/index.js';
import {
  findRelationsTargeting,
  injectInverseReferenceFields,
  inverseColumnName,
  referenceToManyFieldsOf,
} from '../src/core/reference-to-many.js';
import { buildCreateSchema, buildUpdateSchema } from '../src/core/validation.js';
import { columnKind, isFilterableOrSortable, isKnownColumn, isOperatorValidForKind } from '../src/router/fields.js';
import { allColumnKeys } from '../src/router/columns.js';
import { parseInclude, parseListQuery } from '../src/router/query.js';
import { generateSchemaSource } from '../src/codegen/schema-gen.js';
import type { ScannedModel } from '../src/codegen/scan.js';
import { createApiRouter } from '../src/router/create-router.js';

const Comment = defineModel('comments', {
  fields: { body: field.text({ required: true }) },
  api: { public: true },
});

const Article = defineModel('articles', {
  fields: {
    title: field.string({ required: true }),
    comments: field.referenceToMany('comments'),
  },
  api: { public: true },
});

// The runtime registry injects the inverse `reference` field onto the target (as `buildRegistryMap`
// does in production) so `?include=comments` can read the `articlesId` column back off `comments`.
const registry = Object.fromEntries(injectInverseReferenceFields([Article, Comment]).map((m) => [m.name, m]));

describe('field.referenceToMany()', () => {
  it('produces a kind: referenceToMany definition with no column-backed options set', () => {
    const f = field.referenceToMany('comments');
    expect(f).toMatchObject({ kind: 'referenceToMany', targetModel: 'comments', required: false, unique: false, indexed: false, sensitive: false });
  });

  it('defineModel rejects a self-referential referenceToMany (use field.tree instead)', () => {
    expect(() =>
      defineModel('nodes_fixture', {
        fields: { children: field.referenceToMany('nodes_fixture') },
      }),
    ).toThrow(/self-referential/);
  });
});

describe('core/reference-to-many.ts: inverse field synthesis', () => {
  const relation = referenceToManyFieldsOf(Article)[0]!;

  it('referenceToManyFieldsOf finds the relation declared on Article', () => {
    const found = referenceToManyFieldsOf(Article);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceModel: Article, fieldKey: 'comments' });
  });

  it('inverseColumnName defaults to <sourceModelName>Id', () => {
    expect(inverseColumnName(relation)).toBe('articlesId');
  });

  it('inverseColumnName honors an explicit inverseColumn override', () => {
    const custom = defineModel('articles2', { fields: { comments: field.referenceToMany('comments', { inverseColumn: 'ownerId' }) } });
    expect(inverseColumnName(referenceToManyFieldsOf(custom)[0]!)).toBe('ownerId');
  });

  it('findRelationsTargeting finds Article.comments from the Comment side, with no declaration on Comment itself', () => {
    const found = findRelationsTargeting(registry, 'comments');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sourceModel: Article, fieldKey: 'comments' });
    expect(referenceToManyFieldsOf(Comment)).toEqual([]);
  });

  it('injectInverseReferenceFields adds an indexed, non-required `reference` field on the target', () => {
    const [article, comment] = injectInverseReferenceFields([Article, Comment]);
    expect(article!.fields).not.toHaveProperty('articlesId'); // no column on the parent
    const inverse = comment!.fields.articlesId;
    expect(inverse).toMatchObject({ kind: 'reference', targetModel: 'articles', required: false, indexed: true });
  });
});

describe('core/validation.ts: referenceToMany schema', () => {
  it('is an always-optional array of uuids on both create and update', () => {
    expect(buildCreateSchema(Article).safeParse({ title: 'x' }).success).toBe(true);
    expect(buildCreateSchema(Article).safeParse({ title: 'x', comments: ['00000000-0000-7000-8000-000000000000'] }).success).toBe(true);
    expect(buildCreateSchema(Article).safeParse({ title: 'x', comments: ['not-a-uuid'] }).success).toBe(false);
    expect(buildUpdateSchema(Article).safeParse({}).success).toBe(true);
  });
});

describe('router/columns.ts + router/fields.ts: referenceToMany is columnless on the parent, has-only', () => {
  it('allColumnKeys excludes the referenceToMany field on the declaring model', () => {
    expect(allColumnKeys(Article)).not.toContain('comments');
    expect(allColumnKeys(Article)).toContain('title');
  });

  it('isKnownColumn true, isFilterableOrSortable false, columnKind is referenceToMany', () => {
    expect(isKnownColumn(Article, 'comments')).toBe(true);
    expect(isFilterableOrSortable(Article, 'comments')).toBe(false);
    expect(columnKind(Article, 'comments')).toBe('referenceToMany');
  });

  it('only `has` is a valid operator for a referenceToMany field', () => {
    expect(isOperatorValidForKind('referenceToMany', 'has')).toBe(true);
    expect(isOperatorValidForKind('referenceToMany', '=')).toBe(false);
    expect(isOperatorValidForKind('referenceToMany', 'in')).toBe(false);
  });
});

describe('router/query.ts: include + filter parsing', () => {
  it('parseInclude accepts the forward name (declared field key)', () => {
    expect(parseInclude(Article, 'comments', registry)).toEqual(['comments']);
  });

  it('parseInclude rejects an unrelated name', () => {
    expect(() => parseInclude(Article, 'nonsense', registry)).toThrow();
  });

  it('parseListQuery accepts a structured `has` filter on a referenceToMany field', () => {
    const params = new URLSearchParams({ filter: JSON.stringify([['comments', 'has', '00000000-0000-7000-8000-000000000000']]) });
    const query = parseListQuery(Article, params, registry);
    expect(query.filters).toEqual([{ field: 'comments', op: 'has', value: '00000000-0000-7000-8000-000000000000' }]);
  });

  it('rejects a bare ?comments=x query param instead of silently building a broken `=` filter', () => {
    const params = new URLSearchParams({ comments: 'some-id' });
    try {
      parseListQuery(Article, params, registry);
      expect.unreachable('expected parseListQuery to throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('INVALID_OPERATOR');
      expect(JSON.stringify((err as { fields?: unknown }).fields)).toMatch(/structured filter syntax/);
    }
  });
});

describe('codegen/schema-gen.ts: inverse FK column emission', () => {
  it('emits an `articlesId` FK column on comments (on delete restrict) and no `comments` column on articles', () => {
    const scanned: ScannedModel[] = [
      { filePath: '/fake/article.model.ts', exportName: 'Article', model: Article },
      { filePath: '/fake/comment.model.ts', exportName: 'Comment', model: Comment },
    ];
    const src = generateSchemaSource(scanned, 'postgres');

    // the comments table carries the inverse FK column + restrict reference
    expect(src).toContain('articlesId: uuid');
    expect(src).toContain(".references(() => articlesTable.id, { onDelete: 'restrict' })");

    // the articles table itself must not gain a `comments` column — the relation is virtual.
    const articlesTableSrc = src.slice(src.indexOf("pgTable('articles'"), src.indexOf("pgTable('comments'"));
    expect(articlesTableSrc).not.toMatch(/\n\s*comments:/);
  });
});

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('referenceToMany end-to-end (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let app: ReturnType<typeof createApiRouter>;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS articles (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        title varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS comments (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        body text NOT NULL,
        articles_id uuid REFERENCES articles(id) ON DELETE RESTRICT
      )`);
    app = createApiRouter(registry, db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE comments, articles`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS comments`);
    await db.execute(sql`DROP TABLE IF EXISTS articles`);
    await client.end();
  });

  async function createComment(body: string): Promise<string> {
    const res = await app.request('/comments', { method: 'POST', body: JSON.stringify({ body }), headers: { 'content-type': 'application/json' } });
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it('POST /articles with comments: [...] creates the row and sets the inverse FK on each child', async () => {
    const [c1, c2] = await Promise.all([createComment('first'), createComment('second')]);
    const res = await app.request('/articles', {
      method: 'POST',
      body: JSON.stringify({ title: 'Hello', comments: [c1, c2] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const article = ((await res.json()) as { data: { id: string } }).data;

    const get = await app.request(`/articles/${article.id}?include=comments`);
    const body = (await get.json()) as { data: { comments: { id: string; body: string }[] } };
    expect(body.data.comments.map((c) => c.body).sort()).toEqual(['first', 'second']);

    const childRows = (await db.execute(sql`SELECT articles_id FROM comments WHERE id IN (${c1}, ${c2})`)) as unknown as { articles_id: string | null }[];
    expect(childRows.every((r) => r.articles_id === article.id)).toBe(true);
  });

  it('PATCH /articles/:id with a new comments: [...] replaces the set (add + remove in one call)', async () => {
    const [c1, c2, c3] = await Promise.all([createComment('a'), createComment('b'), createComment('c')]);
    const created = await app.request('/articles', { method: 'POST', body: JSON.stringify({ title: 'X', comments: [c1, c2] }), headers: { 'content-type': 'application/json' } });
    const article = ((await created.json()) as { data: { id: string } }).data;

    await app.request(`/articles/${article.id}`, { method: 'PATCH', body: JSON.stringify({ comments: [c2, c3] }), headers: { 'content-type': 'application/json' } });

    const get = await app.request(`/articles/${article.id}?include=comments`);
    const body = (await get.json()) as { data: { comments: { body: string }[] } };
    expect(body.data.comments.map((c) => c.body).sort()).toEqual(['b', 'c']);

    // c1 was detached (inverse FK nulled), c3 reassigned from "unparented" to this article.
    const rows = (await db.execute(sql`SELECT id, articles_id FROM comments`)) as unknown as { id: string; articles_id: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.articles_id]));
    expect(byId.get(c1)).toBeNull();
    expect(byId.get(c2)).toBe(article.id);
    expect(byId.get(c3)).toBe(article.id);
  });

  it('?filter=[["comments","has",id]] narrows articles to ones carrying that comment', async () => {
    const [wanted, other] = await Promise.all([createComment('wanted'), createComment('other')]);
    await app.request('/articles', { method: 'POST', body: JSON.stringify({ title: 'Match', comments: [wanted] }), headers: { 'content-type': 'application/json' } });
    await app.request('/articles', { method: 'POST', body: JSON.stringify({ title: 'NoMatch', comments: [other] }), headers: { 'content-type': 'application/json' } });

    const res = await app.request(`/articles?filter=${encodeURIComponent(JSON.stringify([['comments', 'has', wanted]]))}`);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((a) => a.title)).toEqual(['Match']);
  });

  it('soft-removing an Article detaches its children (inverse FK nulled, not the children deleted)', async () => {
    const c1 = await createComment('doomed-child');
    const created = await app.request('/articles', { method: 'POST', body: JSON.stringify({ title: 'X', comments: [c1] }), headers: { 'content-type': 'application/json' } });
    const article = ((await created.json()) as { data: { id: string } }).data;

    await app.request(`/articles/${article.id}`, { method: 'DELETE' });

    const rows = (await db.execute(sql`SELECT deleted_at, articles_id FROM comments WHERE id = ${c1}`)) as unknown as { deleted_at: string | null; articles_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).toBeNull(); // the comment itself is untouched
    expect(rows[0]!.articles_id).toBeNull(); // but it's detached from the removed parent

    // The removed article is no longer fetchable (soft delete), so we assert the detach via the child's
    // FK directly rather than through a parent include.
  });
});
