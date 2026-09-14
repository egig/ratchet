import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { FileStorage } from '@flystorage/file-storage';
import { InMemoryStorageAdapter } from '@flystorage/in-memory';
import { defineModel, field } from '../src/core/index.js';
import { presetFields } from '../src/auth/index.js';
import { createApiRouter } from '../src/router/create-router.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('createApiRouter (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let app: ReturnType<typeof createApiRouter>;

  // `api: { public: true }` — this suite tests routing/filtering/pagination mechanics, not
  // auth, and has no Role/User/Session fixtures of its own (see auth.test.ts /
  // router.test.ts's sibling suites for that); the generic router otherwise requires a matching
  // role grant by default for every route, including reads (see create-router.ts).
  const Author = defineModel('authors', {
    fields: {
      name: field.string({ required: true, indexed: true }),
    },
    api: { public: true },
  });

  const Book = defineModel('books', {
    fields: {
      authorId: field.reference('authors', { required: true, indexed: true }),
      title: field.string({ required: true }),
      price: field.decimal({ precision: 10, scale: 2, required: true }),
      status: field.enum(['draft', 'published'], { default: 'draft', indexed: true }),
    },
    api: { public: true },
  });

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS authors (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS books (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        author_id uuid NOT NULL, title varchar NOT NULL, price numeric(10,2) NOT NULL, status varchar NOT NULL DEFAULT 'draft'
      )`);
    app = createApiRouter({ authors: Author, books: Book }, db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE books, authors`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS books`);
    await db.execute(sql`DROP TABLE IF EXISTS authors`);
    await client.end();
  });

  async function createAuthor(name: string): Promise<string> {
    const res = await app.request('/authors', { method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' } });
    const body = (await res.json()) as { data: { id: string } };
    return body.data.id;
  }

  it('POST creates a record and returns { data } with 201', async () => {
    const authorId = await createAuthor('Ada');
    const res = await app.request('/books', {
      method: 'POST',
      body: JSON.stringify({ authorId, title: 'Notes', price: '19.99' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ title: 'Notes', price: '19.99', status: 'draft' });
    expect(body.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // Q25/serialize.ts: ISO 8601, not driver text
  });

  it('GET /:model/:id returns { data }, 404 NOT_FOUND for a missing id', async () => {
    const authorId = await createAuthor('Grace');
    const ok = await app.request(`/authors/${authorId}`);
    expect(ok.status).toBe(200);

    const missing = await app.request('/authors/00000000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  it('unknown model -> 404 MODEL_NOT_FOUND', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'MODEL_NOT_FOUND' } });
  });

  it('a model declared with `api: { hidden: true }` 404s on every verb, same as an unknown model', async () => {
    // no table needed — `resolveModel` 404s before any query runs (see create-router.ts).
    const Secret = defineModel('secrets', {
      fields: { value: field.string({ required: true }) },
      api: { hidden: true },
    });
    const hiddenApp = createApiRouter({ authors: Author, secrets: Secret }, db);

    const list = await hiddenApp.request('/secrets');
    expect(list.status).toBe(404);
    expect(await list.json()).toEqual({ error: { code: 'MODEL_NOT_FOUND' } });

    const create = await hiddenApp.request('/secrets', {
      method: 'POST',
      body: JSON.stringify({ value: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(create.status).toBe(404);
  });

  it('list envelope is { data, meta: { total, limit, offset } } by default', async () => {
    await createAuthor('A');
    await createAuthor('B');
    const res = await app.request('/authors');
    const body = (await res.json()) as { data: unknown[]; meta: Record<string, unknown> };
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual({ total: 2, limit: 20, offset: 0 });
  });

  it('?limit= is clamped to the max, not rejected (Q16)', async () => {
    const res = await app.request('/authors?limit=99999');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { limit: number } };
    expect(body.meta.limit).toBe(100);
  });

  it('equality filter on an indexed field narrows results', async () => {
    const a1 = await createAuthor('Filter Author 1');
    await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: a1, title: 'X', price: '1.00', status: 'published' }) });
    await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: a1, title: 'Y', price: '2.00' }) });

    const res = await app.request('/books?status=published');
    const body = (await res.json()) as { data: { status: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('published');
  });

  it('filtering a non-indexed field -> 400 UNFILTERABLE_FIELD', async () => {
    const res = await app.request('/books?title=X');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNFILTERABLE_FIELD');
  });

  it('sorting a non-indexed field -> 400 UNSORTABLE_FIELD (distinct code from filter)', async () => {
    const res = await app.request('/books?sort=title');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNSORTABLE_FIELD');
  });

  it('an operator invalid for the field kind -> 400 INVALID_OPERATOR', async () => {
    const res = await app.request('/books?filter=' + encodeURIComponent(JSON.stringify([['status', 'like', '%x%']])));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_OPERATOR');
  });

  it('`ilike` matches case-insensitively on an indexed string field', async () => {
    await createAuthor('Ada Lovelace');
    await createAuthor('Grace Hopper');

    const res = await app.request('/authors?filter=' + encodeURIComponent(JSON.stringify([['name', 'ilike', '%ada%']])));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data.map((a) => a.name)).toEqual(['Ada Lovelace']);
  });

  it('`ilike` is rejected for a non-text field kind -> 400 INVALID_OPERATOR', async () => {
    const res = await app.request('/books?filter=' + encodeURIComponent(JSON.stringify([['status', 'ilike', '%x%']])));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_OPERATOR');
  });

  it('a bare ?sort= stays offset-mode (keeps { total, limit, offset }), rows sorted', async () => {
    const a = await createAuthor('Sort Author');
    for (const [title, status] of [['b1', 'published'], ['b2', 'draft'], ['b3', 'published']] as const) {
      await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: a, title, price: '1.00', status }) });
    }

    const res = await app.request('/books?sort=status');
    const body = (await res.json()) as { data: { status: string }[]; meta: Record<string, unknown> };
    expect(body.meta).toEqual({ total: 3, limit: 20, offset: 0 });
    expect(body.data.map((r) => r.status)).toEqual(['draft', 'published', 'published']);
  });

  it('multi-key ?sort= orders by each key in turn (comma-separated, `-` for desc)', async () => {
    const a = await createAuthor('Multi Sort Author');
    for (const [title, status] of [['b1', 'published'], ['b2', 'draft'], ['b3', 'published'], ['b4', 'draft']] as const) {
      await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: a, title, price: '1.00', status }) });
    }

    // status asc, then newest-first within each status (id is uuid v7 — monotonic with insert order).
    const res = await app.request('/books?sort=status,-id');
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title)).toEqual(['b4', 'b2', 'b3', 'b1']);
  });

  it('?sort= + ?cursor= is cursor-mode, and the cursor pages forward without repeats', async () => {
    const a = await createAuthor('Cursor Author');
    for (const [title, status] of [['b1', 'draft'], ['b2', 'published'], ['b3', 'draft']] as const) {
      await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId: a, title, price: '1.00', status }) });
    }

    // empty `?cursor=` opts into cursor-mode for the first page.
    const page1 = await app.request('/books?sort=status&limit=2&cursor=');
    const body1 = (await page1.json()) as { data: { title: string }[]; meta: { nextCursor: string | null; hasMore: boolean } };
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.hasMore).toBe(true);
    expect(body1.meta.nextCursor).not.toBeNull();

    const page2 = await app.request(`/books?sort=status&limit=2&cursor=${body1.meta.nextCursor}`);
    const body2 = (await page2.json()) as { data: { title: string }[]; meta: { hasMore: boolean } };
    expect(body2.data).toHaveLength(1);
    expect(body2.meta.hasMore).toBe(false);

    const allTitles = [...body1.data, ...body2.data].map((r) => r.title).sort();
    expect(allTitles).toEqual(['b1', 'b2', 'b3']);
  });

  it('?cursor= with a multi-key ?sort= -> 400 (cursor paging is single-key only)', async () => {
    const res = await app.request('/books?sort=status,-id&cursor=');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('?include=<relation> expands as a sibling key without dropping the FK scalar (Q5)', async () => {
    const authorId = await createAuthor('Included Author');
    await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId, title: 'Z', price: '3.00' }) });

    const res = await app.request('/books?include=author');
    const body = (await res.json()) as { data: { authorId: string; author: { name: string } }[] };
    expect(body.data[0]!.authorId).toBe(authorId);
    expect(body.data[0]!.author).toMatchObject({ name: 'Included Author' });
  });

  it('multi-hop include is rejected, not silently truncated (Q20)', async () => {
    const res = await app.request('/books?include=author.publisher');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_INCLUDE');
  });

  it('PATCH partially updates and DELETE soft-deletes (excluded from list/get, visible via includeDeleted)', async () => {
    const authorId = await createAuthor('Del Author');
    const createRes = await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorId, title: 'ToDelete', price: '5.00' }) });
    const created = ((await createRes.json()) as { data: { id: string } }).data;

    const patchRes = await app.request(`/books/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: '6.00' }) });
    expect(((await patchRes.json()) as { data: { price: string; title: string } }).data).toMatchObject({ price: '6.00', title: 'ToDelete' });

    const delRes = await app.request(`/books/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { data: { deletedAt: string | null } }).data.deletedAt).not.toBeNull();

    const getRes = await app.request(`/books/${created.id}`);
    expect(getRes.status).toBe(404);

    const getDeletedRes = await app.request(`/books/${created.id}?includeDeleted=true`);
    expect(getDeletedRes.status).toBe(200);
  });

  it('POST with a malformed body -> 400 VALIDATION_ERROR, not a 500', async () => {
    const res = await app.request('/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  describe('custom operations (POST /:model/:id/:operation)', () => {
    // `api: { public: true }` — same reasoning as `Author`/`Book` above: this suite is about the
    // custom-operation dispatch mechanics (core/model.ts's `CustomOperationDefinition`), not
    // permission gating (see test/auth.test.ts for the field-permission story, Q4/Q10).
    const Document = defineModel('opdocs', {
      fields: {
        title: field.string({ required: true }),
        locked: field.boolean({ default: false }),
      },
      operations: {
        // the headline example (Q1's `lock`/`unlock`): a whole `update`-shaped write, built from
        // the `presetFields` sugar helper instead of hand-writing `pipe(validate, persist)`.
        lock: presetFields({ locked: true }),
        unlock: { pipeline: presetFields({ locked: false }), console: { label: 'Unlock' } },
        // a param-taking operation (Q2/Q14) — params merge into `ctx.input` the same way a preset
        // value does, so `presetFields` picks it up without needing to know about "params" at all.
        retitle: { pipeline: presetFields({}), params: { title: field.string({ required: true }) } },
      },
      api: { public: true },
    });

    let opsApp: ReturnType<typeof createApiRouter>;

    beforeAll(async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS opdocs (
          id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
          title varchar NOT NULL, locked boolean NOT NULL DEFAULT false
        )`);
      opsApp = createApiRouter({ opdocs: Document }, db);
    });

    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE opdocs`);
    });

    afterAll(async () => {
      await db.execute(sql`DROP TABLE IF EXISTS opdocs`);
    });

    async function createDoc(title: string): Promise<string> {
      const res = await opsApp.request('/opdocs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
      return ((await res.json()) as { data: { id: string } }).data.id;
    }

    it('a param-less custom operation performs its preset write and returns the full updated resource', async () => {
      const id = await createDoc('Doc A');
      const res = await opsApp.request(`/opdocs/${id}/lock`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string; title: string; locked: boolean } };
      expect(body.data).toMatchObject({ id, title: 'Doc A', locked: true });

      const unlockRes = await opsApp.request(`/opdocs/${id}/unlock`, { method: 'POST' });
      expect(((await unlockRes.json()) as { data: { locked: boolean } }).data.locked).toBe(false);
    });

    it('a param-taking custom operation validates and applies its body', async () => {
      const id = await createDoc('Old Title');
      const res = await opsApp.request(`/opdocs/${id}/retitle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New Title' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { title: string } }).data.title).toBe('New Title');

      const badRes = await opsApp.request(`/opdocs/${id}/retitle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(badRes.status).toBe(400);
      expect(((await badRes.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('an unknown operation name -> 404 OPERATION_NOT_FOUND', async () => {
      const id = await createDoc('Doc B');
      const res = await opsApp.request(`/opdocs/${id}/nope`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OPERATION_NOT_FOUND');
    });

    it("dispatching 'create'/'update'/'remove' through this route 404s — they keep their own dedicated verbs/field checks", async () => {
      const id = await createDoc('Doc C');
      const res = await opsApp.request(`/opdocs/${id}/update`, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OPERATION_NOT_FOUND');
    });

    it("registering the custom-operation route doesn't shadow a model's own POST /:model/:field/upload", async () => {
      const Photo = defineModel('opphotos', {
        fields: { image: field.file() },
        api: { public: true },
      });
      const memoryStorage = new FileStorage(new InMemoryStorageAdapter());
      const photoApp = createApiRouter({ opphotos: Photo }, db, memoryStorage);
      const res = await photoApp.request('/opphotos/image/upload', {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'x.jpg', { type: 'image/jpeg' }));
          return form;
        })(),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: { filename: string } }).data.filename).toBe('x.jpg');
    });

    it('GET /:model/:id/:field streams a file field back from the flystorage-backed storage, and 404s if the blob is gone', async () => {
      const Photo = defineModel('opphotos2', { fields: { image: field.file() }, api: { public: true } });
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS opphotos2 (
          id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
          image jsonb
        )`);
      try {
        const memoryStorage = new FileStorage(new InMemoryStorageAdapter());
        const photoApp = createApiRouter({ opphotos2: Photo }, db, memoryStorage);

        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5]);
        const uploadRes = await photoApp.request('/opphotos2/image/upload', {
          method: 'POST',
          body: (() => {
            const form = new FormData();
            form.append('file', new File([bytes], 'pic.jpg', { type: 'image/jpeg' }));
            return form;
          })(),
        });
        expect(uploadRes.status).toBe(201);
        const stored = ((await uploadRes.json()) as { data: { key: string } }).data;

        const createRes = await photoApp.request('/opphotos2', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: stored }),
        });
        expect(createRes.status).toBe(201);
        const id = ((await createRes.json()) as { data: { id: string } }).data.id;

        const downloadRes = await photoApp.request(`/opphotos2/${id}/image`);
        expect(downloadRes.status).toBe(200);
        expect(downloadRes.headers.get('content-type')).toBe('image/jpeg');
        expect(new Uint8Array(await downloadRes.arrayBuffer())).toEqual(bytes);

        // the row still references the blob, but it's gone from storage — must 404 cleanly, not throw/hang.
        await memoryStorage.deleteFile(stored.key);
        const missingRes = await photoApp.request(`/opphotos2/${id}/image`);
        expect(missingRes.status).toBe(404);
      } finally {
        await db.execute(sql`DROP TABLE IF EXISTS opphotos2`);
      }
    });
  });
});
