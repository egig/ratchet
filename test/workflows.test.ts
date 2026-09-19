import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { wrapDb, type AnyDb } from '../src/core/db.js';
import { defineModel } from '../src/core/model.js';
import { field } from '../src/core/field.js';
import { pipe, persist, validate } from '../src/core/pipeline.js';
import { insertRow, fetchRow, updateRow } from '../src/core/persistence.js';
import { toSnakeCase } from '../src/core/naming.js';
import { User } from '../src/auth/models/user.model.js';
import { Role } from '../src/auth/models/role.model.js';
import { Session } from '../src/auth/models/session.model.js';
import {
  workflowModels,
  Workflow,
  WorkflowVersion,
  WorkflowRun,
  WorkflowStep,
} from '../src/workflows/models.js';
import { WorkflowRuntime, rows, type RunPayload } from '../src/workflows/runtime.js';
import { createWorkflowRouter } from '../src/workflows/router.js';
import { defaultGraph, validateGraph, type Graph } from '../src/workflows/graph.js';
import type { DurableSteps } from '../src/workflows/adapter.js';

const Product = defineModel('products', {
  fields: {
    name: field.string({ required: true }),
    count: field.integer(),
    secret: field.string({ sensitive: true }),
  },
});
let client: Client, db: AnyDb, runtime: WorkflowRuntime, roleId: string, serviceId: string;
const registry = Object.fromEntries(
  [...workflowModels, Product, Role, User, Session].map((m) => [m.name, m]),
);
const immediate: DurableSteps = { run: async (_id, fn) => fn() };
const literal = (value: string | number) => ({ kind: 'literal' as const, value });
const graph = (): Graph => ({
  ...defaultGraph(),
  trigger: { model: 'products', event: 'create' },
  nodes: [
    ...defaultGraph().nodes,
    {
      id: 'write',
      kind: 'model',
      operation: 'create',
      label: 'Create',
      position: { x: 200, y: 0 },
      model: 'products',
      inputs: { name: literal('generated'), count: literal(1) },
    },
  ],
  edges: [{ source: 'trigger', target: 'write', port: 'next' }],
});
async function fixture(g = graph()) {
  const w = await insertRow(db, Workflow, { name: 'Test', draft: g, roleId, serviceId, enabled: true });
  const v = await insertRow(db, WorkflowVersion, { workflowId: w.id, graph: g, roleId, serviceId });
  await updateRow(db, Workflow, String(w.id), { publishedVersionId: v.id });
  return { w, v };
}
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = wrapDb(drizzle(client), 'sqlite');
  for (const m of Object.values(registry)) {
    const fields = Object.entries(m.fields).map(
      ([k, f]) =>
        `${toSnakeCase(k)} ${f.kind === 'boolean' || f.kind === 'integer' ? 'INTEGER' : 'TEXT'}${f.unique ? ' UNIQUE' : ''}`,
    );
    await db.run(
      sql.raw(
        `CREATE TABLE ${m.tableName} (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, deleted_at TEXT, created_by_id TEXT, ${fields.join(',')})`,
      ),
    );
  }
  roleId = String(
    (
      await insertRow(db, Role, {
        name: 'Automation',
        permissions: {
          products: { '*': { fields: '*', scope: 'any' } },
          workflows: { '*': { fields: '*' } },
        },
      })
    ).id,
  );
  serviceId = String(
    (await insertRow(db, User, { email: 'service@test', passwordHash: '!', active: false, roleId })).id,
  );
  runtime = new WorkflowRuntime(db, registry, { adapter: 'inngest', appId: 'test' });
});
afterEach(() => client.close());

describe('model workflow durability', () => {
  test('committed model writes enqueue a pinned version; rollback emits nothing', async () => {
    const { v } = await fixture();
    await expect(
      db.transaction(async (tx) => {
        await Product.operations.create({
          operation: 'create',
          model: Product,
          input: { name: 'rolled back' },
          doc: null,
          db: runtime.observe(tx),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(await rows(db, WorkflowRun)).toHaveLength(0);
    await Product.operations.create({
      operation: 'create',
      model: Product,
      input: { name: 'saved', secret: 'do not leak' },
      doc: null,
      db: runtime.observe(),
    });
    const runs = await rows(db, WorkflowRun);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.versionId).toBe(v.id);
    expect(JSON.stringify(runs[0]!.payload)).not.toContain('do not leak');
  });
  test('replayed execution does not duplicate a completed write or recursively trigger itself', async () => {
    await fixture();
    await Product.operations.create({
      operation: 'create',
      model: Product,
      input: { name: 'source' },
      doc: null,
      db: runtime.observe(),
    });
    const [run] = await rows(db, WorkflowRun);
    await runtime.execute(String(run!.id), immediate);
    await runtime.execute(String(run!.id), immediate);
    expect(await rows(db, Product)).toHaveLength(2);
    expect(await rows(db, WorkflowRun)).toHaveLength(1);
    expect((await fetchRow(db, WorkflowRun, String(run!.id)))!.status).toBe('succeeded');
  });
  test('failed dispatch stays pending and retries with the same run ID', async () => {
    await fixture();
    await Product.operations.create({
      operation: 'create',
      model: Product,
      input: { name: 'source' },
      doc: null,
      db: runtime.observe(),
    });
    const sent: string[] = [];
    runtime.adapter = {
      handle: async () => new Response(),
      dispatch: async (id) => {
        sent.push(id);
        if (sent.length === 1) throw new Error('offline');
      },
    };
    await expect(runtime.dispatch()).rejects.toThrow('offline');
    expect(await runtime.dispatch()).toBe(1);
    expect(sent[0]).toBe(sent[1]);
    expect(await runtime.dispatch()).toBe(0);
  });
  test('revoked permissions stop new steps', async () => {
    const { w, v } = await fixture();
    const run = await db.transaction((tx) =>
      runtime.enqueue(tx, w, String(v.id), {
        graph: graph(),
        roleId,
        serviceId,
        trigger: {},
        chain: [String(w.id)],
      }),
    );
    await updateRow(db, Role, roleId, { permissions: {} });
    await expect(runtime.execute(String(run.id), immediate)).rejects.toThrow('Missing permission');
    expect(await rows(db, Product)).toHaveLength(0);
  });
  test('parallel loop continues failed items and recovers only failed work', async () => {
    const g: Graph = {
      ...defaultGraph(),
      nodes: [
        ...defaultGraph().nodes,
        {
          id: 'loop',
          kind: 'foreach',
          label: 'Loop',
          position: { x: 100, y: 0 },
          concurrency: 2,
          inputs: { items: { kind: 'literal', value: [{ name: 'good' }, { name: 5 }] } },
        },
        {
          id: 'write',
          parentId: 'loop',
          kind: 'model',
          operation: 'create',
          label: 'Create',
          model: 'products',
          position: { x: 0, y: 0 },
          inputs: { name: { kind: 'ref', source: 'item', path: ['name'] } },
        },
      ],
      edges: [{ source: 'trigger', target: 'loop', port: 'next' }],
    };
    const { w, v } = await fixture(g);
    const run = await db.transaction((tx) =>
      runtime.enqueue(tx, w, String(v.id), {
        graph: g,
        roleId,
        serviceId,
        trigger: {},
        chain: [String(w.id)],
      }),
    );
    await runtime.execute(String(run.id), immediate);
    expect((await fetchRow(db, WorkflowRun, String(run.id)))!.status).toBe('partial');
    expect(await rows(db, Product)).toHaveLength(1);
    // A transient backend failure can be repaired without changing graph/input. Here a temporarily broken validator is repaired.
    const original = Product.operations.create;
    Product.operations.create = pipe(
      async (ctx) => ({ ...ctx, input: { ...ctx.input, name: String(ctx.input.name) } }),
      validate,
      persist,
    );
    try {
      const retry = await db.transaction((tx) =>
        runtime.enqueue(
          tx,
          w,
          String(v.id),
          { ...(run.payload as RunPayload), rootRunId: String(run.id), recovery: true },
          String(run.id),
        ),
      );
      await runtime.execute(String(retry.id), immediate);
      expect((await rows(db, WorkflowStep)).filter((s) => s.status === 'failed').map((s) => s.error)).toEqual(
        [],
      );
      expect((await fetchRow(db, WorkflowRun, String(retry.id)))!.status).toBe('succeeded');
      expect(await rows(db, Product)).toHaveLength(2);
    } finally {
      Product.operations.create = original;
    }
  });
});

test('graph rejects cycles, nested loops, unavailable references and duplicate outputs', () => {
  const g = graph();
  expect(validateGraph(g, registry)).toEqual(g);
  expect(() =>
    validateGraph(
      { ...g, edges: [...g.edges, { source: 'write', target: 'trigger', port: 'next' }] },
      registry,
    ),
  ).toThrow();
  expect(() => validateGraph({ ...g, edges: [...g.edges, ...g.edges] }, registry)).toThrow();
  g.nodes[1]!.inputs.name = { kind: 'ref', source: 'missing', path: ['name'] };
  expect(() => validateGraph(g, registry)).toThrow('earlier node');
});

test('workflow routes require authentication and private persistence is not public', async () => {
  const app = createWorkflowRouter(runtime);
  expect((await app.request('/')).status).toBe(401);
  expect((await app.request('/runs/anything/retry', { method: 'POST' })).status).toBe(401);
});

test('recovery repairs a later loop without replaying the partial branch', async () => {
  const g: Graph = {
    ...defaultGraph(),
    nodes: [
      ...defaultGraph().nodes,
      {
        id: 'a',
        kind: 'foreach',
        label: 'A',
        position: { x: 0, y: 0 },
        inputs: { items: { kind: 'literal', value: [{ name: 'a' }] } },
      },
      {
        id: 'aw',
        parentId: 'a',
        kind: 'model',
        operation: 'create',
        model: 'products',
        label: 'A write',
        position: { x: 0, y: 0 },
        inputs: { name: { kind: 'ref', source: 'item', path: ['name'] } },
      },
      {
        id: 'b',
        kind: 'foreach',
        label: 'B',
        position: { x: 0, y: 0 },
        inputs: { items: { kind: 'literal', value: [{ name: 7 }] } },
      },
      {
        id: 'bw',
        parentId: 'b',
        kind: 'model',
        operation: 'create',
        model: 'products',
        label: 'B write',
        position: { x: 0, y: 0 },
        inputs: { name: { kind: 'ref', source: 'item', path: ['name'] } },
      },
      {
        id: 'notify',
        kind: 'model',
        operation: 'create',
        model: 'products',
        label: 'Partial branch',
        position: { x: 0, y: 0 },
        inputs: { name: literal('notified') },
      },
    ],
    edges: [
      { source: 'trigger', target: 'a', port: 'next' },
      { source: 'a', target: 'b', port: 'success' },
      { source: 'b', target: 'notify', port: 'partial' },
    ],
  };
  const { w, v } = await fixture(g);
  const run = await db.transaction((tx) =>
    runtime.enqueue(tx, w, String(v.id), { graph: g, roleId, serviceId, trigger: {}, chain: [String(w.id)] }),
  );
  await runtime.execute(String(run.id), immediate);
  expect((await rows(db, Product)).map((p) => p.name).sort()).toEqual(['a', 'notified']);
  const original = Product.operations.create;
  Product.operations.create = pipe(
    async (ctx) => ({ ...ctx, input: { ...ctx.input, name: String(ctx.input.name) } }),
    validate,
    persist,
  );
  try {
    const retry = await db.transaction((tx) =>
      runtime.enqueue(
        tx,
        w,
        String(v.id),
        { ...(run.payload as RunPayload), rootRunId: String(run.id), recovery: true },
        String(run.id),
      ),
    );
    await runtime.execute(String(retry.id), immediate);
    expect((await rows(db, Product)).map((p) => p.name).sort()).toEqual(['7', 'a', 'notified']);
    expect((await fetchRow(db, WorkflowRun, String(retry.id)))!.status).toBe('succeeded');
  } finally {
    Product.operations.create = original;
  }
});

test('pipeline post-commit failure does not roll back or duplicate the write', async () => {
  let hooks = 0;
  const original = Product.operations.create;
  Product.operations.create = pipe(validate, persist, async (ctx) => {
    hooks++;
    if (hooks === 1) throw new Error('temporary hook failure');
    return ctx;
  });
  try {
    const { w, v } = await fixture();
    const run = await db.transaction((tx) =>
      runtime.enqueue(tx, w, String(v.id), {
        graph: graph(),
        roleId,
        serviceId,
        trigger: {},
        chain: [String(w.id)],
      }),
    );
    await expect(runtime.execute(String(run.id), immediate)).rejects.toThrow('temporary hook failure');
    expect(await rows(db, Product)).toHaveLength(1);
    await runtime.execute(String(run.id), immediate);
    expect(await rows(db, Product)).toHaveLength(1);
    expect(hooks).toBe(2);
  } finally {
    Product.operations.create = original;
  }
});

test('a captured field cannot be consumed after its read grant is revoked', async () => {
  const g = graph();
  g.nodes[1]!.inputs.name = { kind: 'ref', source: 'trigger', path: ['after', 'name'] };
  const { w, v } = await fixture(g);
  const run = await db.transaction((tx) =>
    runtime.enqueue(tx, w, String(v.id), {
      graph: g,
      roleId,
      serviceId,
      trigger: { after: { name: 'private' } },
      chain: [String(w.id)],
    }),
  );
  await updateRow(db, Role, roleId, {
    permissions: { products: { create: { fields: '*' }, read: { fields: ['count'] } } },
  });
  await expect(runtime.execute(String(run.id), immediate)).rejects.toThrow('no longer readable');
  expect(await rows(db, Product)).toHaveLength(0);
});
