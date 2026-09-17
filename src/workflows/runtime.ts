import { sql } from 'drizzle-orm';
import type { AnyDb } from '../core/db.js';
import type { ModelDefinition } from '../core/model.js';
import { fetchRow, insertRow, updateRow } from '../core/persistence.js';
import { assertOwnsRow, forceOwnerOnCreate, ownerFieldOf, PipelineError } from '../core/pipeline.js';
import { listPermissionsForRole } from '../auth/lookup.js';
import { assertWriteFieldsAllowed, pickGrantedFields, resolveGrantedFields } from '../auth/pipeline.js';
import { redactSensitiveFields } from '../core/serialize.js';
import { rowToCamelCase } from '../core/naming.js';
import { normalizeJsonFields } from '../core/serialize.js';
import { listRows } from '../router/list.js';
import type { FilterNode } from '../router/query.js';
import { buildParamsSchema } from '../core/validation.js';
import {
  evaluateCondition,
  resolveBinding,
  referenceModel,
  validateGraph,
  type Graph,
  type WorkflowNode,
} from './graph.js';
import { Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, WorkflowOutbox } from './models.js';
import type { DurableSteps, WorkflowAdapter } from './adapter.js';
import type { WorkflowConfig } from './config.js';

export type Row = Record<string, unknown>;
export interface RunPayload {
  graph: Graph;
  roleId: string;
  serviceId: string;
  trigger: Row;
  chain: string[];
  rootRunId?: string;
  recovery?: boolean;
}
export async function rows(
  db: AnyDb,
  model: ModelDefinition,
  where = sql`1 = 1`,
  limit = 100,
): Promise<Row[]> {
  const result = await db.execute(
    sql`SELECT * FROM ${sql.identifier(model.tableName)} WHERE deleted_at IS NULL AND ${where} ORDER BY created_at DESC LIMIT ${limit}`,
  );
  return result.map((r) => normalizeJsonFields(model, rowToCamelCase(r)));
}
export const requireRow = async (db: AnyDb, model: ModelDefinition, id: string): Promise<Row> => {
  const row = await fetchRow(db, model, id);
  if (!row) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  return row;
};

export class WorkflowRuntime {
  adapter?: WorkflowAdapter;
  readonly db: AnyDb;
  private transaction<T>(fn: (db: AnyDb) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
  readonly limits: { items: number; concurrency: number; chainDepth: number };
  constructor(
    db: AnyDb,
    readonly registry: Record<string, ModelDefinition>,
    readonly config: WorkflowConfig,
  ) {
    if (config.adapter !== 'inngest' || !config.appId?.trim()) throw new Error('Configure an Inngest appId for workflows');
    // libSQL's single connection cannot issue reads while another iteration owns a transaction.
    // Serialize connection use, while allowing asynchronous post-commit work to run in parallel.
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn);
      tail = next.catch(() => undefined);
      return next;
    };
    this.db =
      db.dialect === 'sqlite'
        ? {
            dialect: db.dialect,
            execute: (q) => serial(() => db.execute(q)),
            run: (q) => serial(() => db.run(q)),
            transaction: (fn) => serial(() => db.transaction(fn)),
          }
        : db;
    this.limits = { items: 100, concurrency: 5, chainDepth: 10, ...config.limits };
    for (const [key, value] of Object.entries(this.limits))
      if (!Number.isInteger(value) || value < 1 || value > 1000)
        throw new Error(`Invalid workflow limit: ${key}`);
  }
  /** Decorate per-app/per-transaction handles, never global state. */
  observe(db: AnyDb = this.db, chain: string[] = []): AnyDb {
    return {
      dialect: db.dialect,
      execute: (q) => db.execute(q),
      run: (q) => db.run(q),
      transaction: (fn) => db.transaction((tx) => fn(this.observe(tx, chain))),
      onMutation: (event) => this.capture(db, event, chain),
    };
  }
  async readable(db: AnyDb, model: ModelDefinition, row: Row, roleId: string, userId: string): Promise<Row> {
    const grants = await listPermissionsForRole(db, roleId);
    const resource = grants[model.name] ?? grants['*'];
    const grant = resource?.read ?? resource?.['*'];
    if (!grant || (grant.scope !== 'any' && row[ownerFieldOf(model)] !== userId)) return { id: row.id };
    return redactSensitiveFields(
      model,
      pickGrantedFields(model, row, await resolveGrantedFields(db, roleId, model.name, 'read')),
    );
  }
  async capture(
    db: AnyDb,
    event: Parameters<NonNullable<AnyDb['onMutation']>>[0],
    chain: string[],
  ): Promise<void> {
    if (event.model.api?.hidden || chain.length >= this.limits.chainDepth) return;
    const workflows = await rows(db, Workflow, sql`enabled = ${true}`, 1000);
    for (const w of workflows) {
      if (!w.publishedVersionId || chain.includes(String(w.id))) continue;
      const v = await requireRow(db, WorkflowVersion, String(w.publishedVersionId));
      const graph = v.graph as Graph;
      if (graph.trigger.model !== event.model.name || graph.trigger.event !== event.event) continue;
      const permissions = await listPermissionsForRole(db, String(v.roleId));
      const resource = permissions[event.model.name] ?? permissions['*'];
      const grant = resource?.read ?? resource?.['*'];
      if (!grant) continue;
      const record = event.after ?? event.before;
      if (grant.scope !== 'any' && record?.[ownerFieldOf(event.model)] !== v.serviceId) continue;
      const before = event.before
        ? await this.readable(db, event.model, event.before, String(v.roleId), String(v.serviceId))
        : null;
      const after = event.after ? await this.readable(db, event.model, event.after, String(v.roleId), String(v.serviceId)) : null;
      await this.enqueue(db, w, String(v.id), {
        graph,
        roleId: String(v.roleId),
        serviceId: String(v.serviceId),
        chain: [...chain, String(w.id)],
        trigger: {
          model: event.model.name,
          event: event.event,
          before,
          after,
          userId: event.userId ?? null,
          changedFields: Object.keys(after ?? before ?? {}).filter(
            (k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
          ),
        },
      });
    }
  }
  async enqueue(
    db: AnyDb,
    workflow: Row,
    versionId: string,
    payload: RunPayload,
    recoveryOf?: string,
  ): Promise<Row> {
    if (JSON.stringify(payload).length > 256_000) throw new Error('Workflow input exceeds 256 KB');
    const run = await insertRow(db, WorkflowRun, {
      workflowId: workflow.id,
      versionId,
      status: 'queued',
      payload,
      recoveryOf: recoveryOf ?? null,
    });
    await insertRow(db, WorkflowOutbox, { runId: run.id, delivered: false });
    return run;
  }
  async dispatch(): Promise<number> {
    if (!this.adapter) throw new Error('Workflow adapter is not configured');
    const pending = await rows(this.db, WorkflowOutbox, sql`delivered = ${false}`, 100);
    for (const entry of pending) {
      await this.adapter.dispatch(String(entry.runId));
      await updateRow(this.db, WorkflowOutbox, String(entry.id), { delivered: true });
    }
    return pending.length;
  }
  async action(db: AnyDb, n: WorkflowNode, input: Row, p: RunPayload, effectKey?: string): Promise<unknown> {
    const m = this.registry[n.model ?? ''];
    if (!m || m.api?.hidden) throw new Error('Model is unavailable');
    const action =
      n.kind === 'query' || n.kind === 'read' ? 'read' : n.kind === 'operation' ? n.operation! : n.kind;
    const permissions = await listPermissionsForRole(db, p.roleId);
    const resource = permissions[m.name] ?? permissions['*'];
    const grant = resource?.[action] ?? resource?.['*'];
    if (!grant) throw new Error(`Missing permission ${m.name}:${action}`);
    const own = grant.scope !== 'any';
    if (n.kind === 'query') {
      const fields = await resolveGrantedFields(db, p.roleId, m.name, 'read');
      const filters: FilterNode[] = Object.entries(input).map(([field, value]) => {
        if (!(field in m.fields) || m.fields[field]?.sensitive || (fields !== '*' && !fields.has(field)))
          throw new Error('Query field is not readable');
        return { field, op: '=', value } as FilterNode;
      });
      if (own) filters.push({ field: ownerFieldOf(m), op: '=', value: p.serviceId });
      const page = await listRows(db, m, this.registry, {
        limit: this.limits.items + 1,
        offset: 0,
        sort: [{ field: 'id', direction: 'asc' }],
        cursorMode: false,
        include: [],
        includeDeleted: false,
        filters,
      });
      if (page.rows.length > this.limits.items)
        throw new Error(`Query exceeds ${this.limits.items} items; narrow its filters`);
      return {
        items: await Promise.all(page.rows.map((r) => this.readable(db, m, r, p.roleId, p.serviceId))),
        count: page.rows.length,
      };
    }
    const id = typeof input.id === 'string' ? input.id : undefined;
    if (n.kind !== 'create') {
      if (!id) throw new Error('A record ID is required');
      if (own) await assertOwnsRow(db, m, id, p.serviceId);
    }
    if (n.kind === 'read') return this.readable(db, m, await requireRow(db, m, id!), p.roleId, p.serviceId);
    const { id: _, ...values } = input;
    if (n.kind === 'create' || n.kind === 'update')
      assertWriteFieldsAllowed(m, values, await resolveGrantedFields(db, p.roleId, m.name, n.kind));
    const entry = m.operations[action];
    if (!entry) throw new Error('Operation no longer exists');
    const data =
      n.kind === 'operation' && typeof entry !== 'function' && entry.params
        ? (buildParamsSchema(entry.params).parse(values) as Row)
        : values;
    const pipeline = typeof entry === 'function' ? entry : entry.pipeline;
    const result = await pipeline({
      model: m,
      operation: action,
      id,
      effectKey,
      input: n.kind === 'create' ? forceOwnerOnCreate(m, data, p.serviceId) : data,
      doc: null,
      db,
      registry: this.registry,
      user: { id: p.serviceId, roleId: p.roleId },
    });
    return result.doc ? this.readable(db, m, result.doc, p.roleId, p.serviceId) : { id: id ?? null };
  }
  private async assertSnapshotReadable(model: ModelDefinition, value: unknown, p: RunPayload, field?: string): Promise<void> {
    if (!value || typeof value !== 'object') return;
    const row = value as Row;
    const permissions = await listPermissionsForRole(this.db, p.roleId);
    const resource = permissions[model.name] ?? permissions['*'];
    const grant = resource?.read ?? resource?.['*'];
    const fields = await resolveGrantedFields(this.db, p.roleId, model.name, 'read');
    const keys = field ? [field] : Object.keys(row);
    if (!grant || (grant.scope !== 'any' && row[ownerFieldOf(model)] !== p.serviceId) || keys.some(key => model.fields[key]?.sensitive || (key in model.fields && fields !== '*' && !fields.has(key)))) {
      throw new Error(`Source field is no longer readable: ${model.name}.${field ?? '*'}`);
    }
  }
  private async assertEnvironmentReadable(values: Row, p: RunPayload): Promise<void> {
    const triggerModel = this.registry[p.graph.trigger.model];
    const trigger = values.trigger as Row | undefined;
    if (triggerModel) for (const row of [trigger?.before, trigger?.after]) await this.assertSnapshotReadable(triggerModel, row, p);
    for (const node of p.graph.nodes) {
      const model = this.registry[node.model ?? ''];
      const value = values[node.id];
      if (model && value) {
        const records = node.kind === 'query' ? (value as {items:unknown[]}).items : [value];
        for (const row of records) await this.assertSnapshotReadable(model, row, p);
      }
      if (node.kind === 'foreach' && value) for (const item of (value as {results:{output?:Row}[]}).results) if (item.output) await this.assertEnvironmentReadable(item.output,p);
    }
  }
  private async inputs(n: WorkflowNode, values: Row, p: RunPayload): Promise<Row> {
    for (const b of Object.values(n.inputs)) {
      if (b.kind !== 'ref') continue;
      const source = referenceModel(p.graph, n, b, this.registry);
      if (source) {
        const snapshot = b.source === 'trigger' ? (values.trigger as Row)?.[b.path[0]!] : values[b.source];
        await this.assertSnapshotReadable(source.model, snapshot, p, source.field);
      } else {
        const node = p.graph.nodes.find(x => x.id === b.source);
        if (node?.kind === 'query' || node?.kind === 'foreach') await this.assertEnvironmentReadable(values,p);
      }
    }
    return Object.fromEntries(Object.entries(n.inputs).map(([k, b]) => [k, resolveBinding(b, values)]));
  }
  async execute(runId: string, step: DurableSteps): Promise<unknown> {
    const run = await step.run('load-run', () => requireRow(this.db, WorkflowRun, runId));
    const p = run.payload as unknown as RunPayload;
    const g = validateGraph(p.graph, this.registry);
    const root = p.rootRunId ?? runId;
    await step.run('start', async () => {
      await updateRow(this.db, WorkflowRun, runId, { status: 'running', error: null });
      return true;
    });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    let partial = false;
    const walk = async (start: WorkflowNode | undefined, initial: Row, prefix: string): Promise<Row> => {
      const values = { ...initial };
      let n = start;
      while (n) {
        const current = n;
        let port = 'next';
        if (current.kind === 'trigger') {
          values[current.id] = p.trigger;
        } else if (current.kind === 'foreach') {
          const loopKey = `${root}:loop-input/${current.id}`;
          const saved = await step.run(`${current.id}-inputs`, async () => {
            const existing = (await rows(this.db, WorkflowStep, sql`key = ${loopKey}`, 1))[0];
            if (existing) return existing.output as Row;
            const snapshot = { ...values };
            await insertRow(this.db, WorkflowStep, {
              runId,
              key: loopKey,
              status: 'succeeded',
              output: snapshot,
            });
            return snapshot;
          });
          Object.assign(values, saved);
          const input = await this.inputs(current, values, p);
          if (!Array.isArray(input.items) || input.items.length > this.limits.items)
            throw new Error(`For each requires an array of at most ${this.limits.items} items`);
          const body = g.nodes.find(
            (x) => x.parentId === current.id && !g.edges.some((e) => e.target === x.id),
          );
          const results: { index: number; status: string; output?: Row; error?: string }[] = [];
          const concurrency = Math.min(
            current.concurrency ?? this.limits.concurrency,
            this.limits.concurrency,
          );
          for (let offset = 0; offset < input.items.length; offset += concurrency) {
            const batch = input.items.slice(offset, offset + concurrency);
            results.push(
              ...(await Promise.all(
                batch.map(async (item, i) => {
                  const index = offset + i;
                  try {
                    return {
                      index,
                      status: 'succeeded',
                      output: await walk(body, { ...values, item }, `${prefix}${current.id}/${index}/`),
                    };
                  } catch (error) {
                    return {
                      index,
                      status: 'failed',
                      error: error instanceof Error ? error.message : 'Iteration failed',
                    };
                  }
                }),
              )),
            );
          }
          const failed = results.filter((r) => r.status === 'failed');
          values[current.id] = {
            results,
            succeeded: results.filter((r) => r.status === 'succeeded'),
            failed,
          };
          port = failed.length ? 'partial' : 'success';
          partial ||= failed.length > 0;
          // Recovery repairs failed iterations only; it never replays an already-taken downstream branch.
          if (p.recovery) break;
        } else {
          const key = `${root}:${prefix}${current.id}`;
          const output = await step.run(`${prefix}${current.id}`, async () => {
            try {
              const existing = (await rows(this.db, WorkflowStep, sql`key = ${key}`, 1))[0];
              if (existing?.status === 'succeeded') return existing.output;
              const input = await this.inputs(current, values, p);
              let transactionIndex = 0;
              const observed = this.observe(this.db, p.chain);
              // Checkpoint each pipeline transaction before commit. Post-persist hooks retain
              // their normal post-commit semantics and must be idempotent if they call external APIs.
              const actionDb: AnyDb = {
                ...observed,
                transaction: async <T>(fn: (db: AnyDb) => Promise<T>): Promise<T> => {
                  const effectKey = `${key}/transaction-${transactionIndex++}`;
                  return this.transaction(async (tx) => {
                    // Serialize duplicate/recovery effects for this logical execution on Postgres too.
                    await tx.run(sql`UPDATE workflow_runs SET status = status WHERE id = ${root}`);
                    const checkpoint = (await rows(tx, WorkflowStep, sql`key = ${effectKey}`, 1))[0];
                    const scoped = this.observe(tx, p.chain);
                    if (checkpoint) {
                      return {
                        ...(checkpoint.output as Row),
                        db: scoped,
                        model: this.registry[current.model!],
                        registry: this.registry,
                        user: { id: p.serviceId, roleId: p.roleId },
                      } as T;
                    }
                    const result = await fn(scoped);
                    const ctx = result as Record<string, unknown>;
                    if (!ctx || !('doc' in ctx) || !('input' in ctx))
                      throw new Error('Workflow operations must use a model pipeline transaction');
                    const {
                      db: _db,
                      model: _model,
                      registry: _registry,
                      request: _request,
                      ...snapshot
                    } = ctx;
                    await insertRow(tx, WorkflowStep, {
                      runId,
                      key: effectKey,
                      status: 'succeeded',
                      output: snapshot,
                    });
                    return result;
                  });
                },
              };
              const output =
                current.kind === 'condition'
                  ? evaluateCondition(current.operator, input.left, input.right)
                  : await this.action(actionDb, current, input, p, key);
              if (JSON.stringify(output).length > 256_000) throw new Error('Step output exceeds 256 KB');
              await this.transaction(async (tx) => {
                const record = { runId, key, status: 'succeeded', output, error: null };
                if (existing) await updateRow(tx, WorkflowStep, String(existing.id), record);
                else await insertRow(tx, WorkflowStep, record);
              });
              return output;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Step failed';
              await this.transaction(async (tx) => {
                const existing = (await rows(tx, WorkflowStep, sql`key = ${key}`, 1))[0];
                if (!existing)
                  await insertRow(tx, WorkflowStep, { runId, key, status: 'failed', error: message });
                else if (existing.status !== 'succeeded')
                  await updateRow(tx, WorkflowStep, String(existing.id), {
                    status: 'failed',
                    error: message,
                  });
              });
              throw error;
            }
          });
          values[current.id] = output;
          if (current.kind === 'condition') port = output ? 'true' : 'false';
        }
        n = byId.get(g.edges.find((e) => e.source === current.id && e.port === port)?.target ?? '');
      }
      return values;
    };
    let result: Row = {};
    if (p.recovery) {
      const snapshots = await step.run('recovery-loops', () =>
        rows(this.db, WorkflowStep, sql`key LIKE ${root + ':loop-input/%'}`, 100),
      );
      for (const snapshot of snapshots) {
        const loopId = String(snapshot.key).split('loop-input/')[1]!;
        const failed = await step.run(`failed-${loopId}`, () =>
          rows(
            this.db,
            WorkflowStep,
            sql`key LIKE ${root + ':' + loopId + '/%'} AND status = 'failed'`,
            1000,
          ),
        );
        if (failed.length) result = await walk(byId.get(loopId), snapshot.output as Row, '');
      }
    } else
      result = await walk(
        g.nodes.find((n) => n.kind === 'trigger'),
        { trigger: p.trigger },
        '',
      );
    await step.run('finish', async () => {
      await updateRow(this.db, WorkflowRun, runId, { status: partial ? 'partial' : 'succeeded' });
      return true;
    });
    return { status: partial ? 'partial' : 'succeeded', nodes: Object.keys(result) };
  }
}
