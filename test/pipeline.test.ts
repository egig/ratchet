import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { sql } from 'drizzle-orm';
import {
  defineModel,
  field,
  pipe,
  validate,
  persist,
  forceOwnerOnCreate,
  assertOwnsRow,
  PipelineError,
  type PipelineFn,
  type OperationContext,
} from '../src/core/index.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('pipeline primitives (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  const Widget = defineModel('widgets', {
    fields: {
      name: field.string({ required: true }),
      qty: field.integer({ required: false }),
    },
  });

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS widgets (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        created_by_id uuid,
        name varchar NOT NULL,
        qty integer
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE widgets`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS widgets`);
    await client.end();
  });

  function baseCtx(overrides: Partial<OperationContext>): OperationContext {
    return {
      operation: 'create',
      input: {},
      doc: null,
      model: Widget,
      db,
      ...overrides,
    };
  }

  it('pipe() short-circuits when a link throws a PipelineError', async () => {
    const boom: PipelineFn = () => {
      throw new PipelineError({ code: 'BOOM', status: 400 });
    };
    const reachedAfter = { called: false };
    const after: PipelineFn = async (ctx) => {
      reachedAfter.called = true;
      return ctx;
    };

    const run = pipe(validate, boom, persist, after);
    await expect(run(baseCtx({ input: { name: 'x' } }))).rejects.toMatchObject({ code: 'BOOM' });
    expect(reachedAfter.called).toBe(false);

    const rows = await db.execute(sql`SELECT * FROM widgets`);
    expect((rows as unknown as unknown[]).length).toBe(0);
  });

  it('persist performs create: inserts a row and returns it as ctx.doc', async () => {
    const run = pipe(validate, persist);
    const result = await run(baseCtx({ input: { name: 'widget-a', qty: 3 } }));

    expect(result.doc).toMatchObject({ name: 'widget-a', qty: 3 });
    expect(typeof result.doc?.id).toBe('string');

    const rows = (await db.execute(sql`SELECT * FROM widgets`)) as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });

  it('update auto-prefetches ctx.doc before the pipeline body runs (Q3)', async () => {
    const created = await pipe(validate, persist)(baseCtx({ input: { name: 'widget-b', qty: 1 } }));
    const id = created.doc!.id as string;

    let sawPrefetchedDoc: Record<string, unknown> | null = null;
    const captureDoc: PipelineFn = async (ctx) => {
      sawPrefetchedDoc = ctx.doc;
      return ctx;
    };

    const run = pipe(captureDoc, validate, persist);
    await run(baseCtx({ operation: 'update', id, input: { qty: 5 } }));

    expect(sawPrefetchedDoc).toMatchObject({ name: 'widget-b', qty: 1 });
  });

  it('update on a non-existent id throws NOT_FOUND before running any pipeline link', async () => {
    const touched = { called: false };
    const shouldNotRun: PipelineFn = async (ctx) => {
      touched.called = true;
      return ctx;
    };
    const run = pipe(shouldNotRun, validate, persist);

    await expect(
      run(baseCtx({ operation: 'update', id: '00000000-0000-7000-8000-000000000000', input: { qty: 1 } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(touched.called).toBe(false);
  });

  it('persist.remove soft-deletes: sets deletedAt, row still present in the table', async () => {
    const created = await pipe(validate, persist)(baseCtx({ input: { name: 'widget-c' } }));
    const id = created.doc!.id as string;

    const run = pipe(persist.remove);
    const result = await run(baseCtx({ operation: 'remove', id, input: {} }));

    expect(result.doc?.deletedAt).not.toBeNull();

    const rows = (await db.execute(sql`SELECT * FROM widgets WHERE id = ${id}`)) as unknown as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('persist.hardRemove actually deletes the row', async () => {
    const created = await pipe(validate, persist)(baseCtx({ input: { name: 'widget-d' } }));
    const id = created.doc!.id as string;

    await pipe(persist.hardRemove)(baseCtx({ operation: 'remove', id, input: {} }));

    const rows = (await db.execute(sql`SELECT * FROM widgets WHERE id = ${id}`)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('a post-persist step throwing does not roll back the already-committed write (Q11/Q21b)', async () => {
    const notify: PipelineFn = () => {
      throw new PipelineError({ code: 'NOTIFY_FAILED', status: 500 });
    };
    const run = pipe(validate, persist, notify);

    await expect(run(baseCtx({ input: { name: 'widget-e' } }))).rejects.toMatchObject({ code: 'NOTIFY_FAILED' });

    const rows = (await db.execute(sql`SELECT * FROM widgets WHERE name = 'widget-e'`)) as unknown as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('validate rejects a missing required field with a normalized VALIDATION_ERROR', async () => {
    const run = pipe(validate, persist);
    await expect(run(baseCtx({ input: {} }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  describe('forceOwnerOnCreate / assertOwnsRow (pair with ApiModelOptions.ownerField, core/model.ts)', () => {
    // Ownership is now enforced by each entry point (create-router.ts, automation/tool.ts)
    // calling these two plain functions directly, once it resolves the caller's `scope` — not by
    // a pipeline step a model author composes by hand (the old `requireOwnsRow`).
    const OwnedWidget = defineModel('owned_widgets', {
      fields: {
        userId: field.string({ required: true }),
        name: field.string({ required: true }),
      },
      api: { ownerField: 'userId' },
    });
    const UnownedWidget = defineModel('owned_widgets', {
      fields: {
        userId: field.string({ required: true }),
        name: field.string({ required: true }),
      },
    });

    beforeAll(async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS owned_widgets (
          id uuid PRIMARY KEY,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          deleted_at timestamptz,
          created_by_id varchar,
          user_id varchar NOT NULL,
          name varchar NOT NULL
        )
      `);
    });

    beforeEach(async () => {
      await db.execute(sql`TRUNCATE TABLE owned_widgets`);
    });

    afterAll(async () => {
      await db.execute(sql`DROP TABLE IF EXISTS owned_widgets`);
    });

    function ctx(overrides: Partial<OperationContext>): OperationContext {
      return { operation: 'create', input: {}, doc: null, model: OwnedWidget, db, ...overrides };
    }

    it("forceOwnerOnCreate overwrites input[ownerField] with the given user id, ignoring a spoofed value", () => {
      const input = forceOwnerOnCreate(OwnedWidget, { name: 'x', userId: 'someone-else' }, 'user-a');
      expect(input.userId).toBe('user-a');
    });

    it("forceOwnerOnCreate is a no-op for the default createdById case (persistWrite already force-sets it, never reading it from input)", () => {
      const input = forceOwnerOnCreate(UnownedWidget, { name: 'x' }, 'user-a');
      expect(input).toEqual({ name: 'x' });
    });

    it('assertOwnsRow 404s when the row belongs to a different user', async () => {
      const created = await pipe(validate, persist)(ctx({ input: { name: 'x', userId: 'user-a' } }));
      const id = created.doc!.id as string;
      await expect(assertOwnsRow(db, OwnedWidget, id, 'user-b')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('assertOwnsRow resolves when the row belongs to the given user', async () => {
      const created = await pipe(validate, persist)(ctx({ input: { name: 'x', userId: 'user-a' } }));
      const id = created.doc!.id as string;
      await expect(assertOwnsRow(db, OwnedWidget, id, 'user-a')).resolves.toBeUndefined();
    });

    it('assertOwnsRow 404s on a non-existent id', async () => {
      await expect(assertOwnsRow(db, OwnedWidget, '00000000-0000-7000-8000-000000000000', 'user-a')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });

    it('assertOwnsRow falls back to createdById when the model has no explicit ownerField', async () => {
      const created = await pipe(validate, persist)({
        operation: 'create',
        input: { name: 'x', userId: 'irrelevant' },
        doc: null,
        model: UnownedWidget,
        db,
        user: { id: 'user-a' },
      });
      const id = created.doc!.id as string;
      await expect(assertOwnsRow(db, UnownedWidget, id, 'user-a')).resolves.toBeUndefined();
      await expect(assertOwnsRow(db, UnownedWidget, id, 'user-b')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    });
  });
});
