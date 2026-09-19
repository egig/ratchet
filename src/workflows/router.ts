import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { App } from '../router/http-app.js';
import { authorizeRequest } from '../auth/pipeline.js';
import { listPermissionsForRole } from '../auth/lookup.js';
import { insertRow, updateRow } from '../core/persistence.js';
import { User } from '../auth/models/user.model.js';
import { Role } from '../auth/models/role.model.js';
import { PipelineError } from '../core/pipeline.js';
import { serializeModelMeta } from '../console/serialize-model.js';
import { defaultGraph, graphSchema, validateGraph } from './graph.js';
import { Workflow, WorkflowVersion, WorkflowRun, WorkflowStep } from './models.js';
import { requireRow, rows, type RunPayload, type WorkflowRuntime } from './runtime.js';

export function createWorkflowRouter(runtime: WorkflowRuntime): App {
  const app = new App();
  const db = runtime.db;
  const auth = async (request: Request, action: string, workflowId?: string) => {
    const access = await authorizeRequest(db, request, 'workflows', action);
    if (workflowId && access.scope !== 'any') {
      const w = await requireRow(db, Workflow, workflowId);
      if (w.createdById !== access.user.id) throw new PipelineError({ code: 'FORBIDDEN', status: 403 });
    }
    return access;
  };
  app.onError((error, c) =>
    c.json(
      { error: { message: error instanceof Error ? error.message : 'Workflow request failed' } },
      error instanceof PipelineError ? error.status : 400,
    ),
  );
  for (const method of ['get', 'post', 'put'] as const)
    app[method]('/inngest', (c) => runtime.adapter!.handle(c.req.raw));
  app.get('/meta', async (c) => {
    const { user } = await auth(c.req.raw, 'read');
    const permissions = await listPermissionsForRole(db, user.roleId ?? '');
    const grant = permissions.workflows ?? permissions['*'] ?? {};
    return c.json({
      models: Object.values(runtime.registry)
        .filter((m) => !m.api?.hidden)
        .map(serializeModelMeta),
      roles: (await rows(db, Role)).map((r) => ({ id: r.id, name: r.name })),
      permissions: Object.fromEntries(
        ['edit', 'publish', 'run', 'assignRole', 'viewRuns'].map((a) => [a, !!(grant[a] ?? grant['*'])]),
      ),
      limits: runtime.limits,
    });
  });
  app.get('/', async (c) => {
    const access = await auth(c.req.raw, 'read');
    return c.json(
      await rows(db, Workflow, access.scope === 'any' ? sql`1 = 1` : sql`created_by_id = ${access.user.id}`),
    );
  });
  app.post('/', async (c) => {
    const { user } = await auth(c.req.raw, 'edit');
    const body = z.object({ name: z.string().min(1).max(150) }).parse(await c.req.json());
    return c.json(
      await insertRow(db, Workflow, { name: body.name, draft: defaultGraph(), enabled: false }, user.id),
      201,
    );
  });
  app.get('/runs/:id', async (c) => {
    await auth(c.req.raw, 'viewRuns');
    const run = await requireRow(db, WorkflowRun, c.req.param('id'));
    const {user} = await auth(c.req.raw, 'viewRuns', String(run.workflowId));
    // Payload snapshots may contain fields the viewer cannot read. Only service-role execution sees them.
    const { payload, ...publicRun } = run;
    const p = payload as RunPayload;
    const steps = await rows(db, WorkflowStep, sql`key LIKE ${(p.rootRunId ?? run.id) + ':%'}`, 1000);
    const visibleSteps = await Promise.all(steps.filter(s => !String(s.key).includes('/transaction-') && !String(s.key).includes(':loop-input/')).map(async ({output,...s}) => {
      const nodeId = String(s.key).split(':')[1]!.split('/').at(-1);
      const node = p.graph.nodes.find(n => n.id === nodeId);
      const model = runtime.registry[node?.model ?? ''];
      if (!model || !output || typeof output !== 'object') return {...s, label:node?.label};
      const value = output as Record<string,unknown>;
      const safe = node?.operation === 'query' ? {items:await Promise.all((value.items as Record<string,unknown>[]).map(row => runtime.readable(db,model,row,user.roleId ?? '',user.id))),count:value.count} : await runtime.readable(db,model,value,user.roleId ?? '',user.id);
      return {...s,label:node?.label,output:safe};
    }));
    return c.json({ ...publicRun, steps: visibleSteps });
  });
  app.post('/runs/:id/retry', async (c) => {
    await auth(c.req.raw, 'run');
    const previous = await requireRow(db, WorkflowRun, c.req.param('id'));
    await auth(c.req.raw, 'run', String(previous.workflowId));
    if (!['failed', 'partial'].includes(String(previous.status)))
      throw new Error('Only failed or partial runs can be recovered');
    const p = previous.payload as RunPayload;
    const w = await requireRow(db, Workflow, String(previous.workflowId));
    const run = await db.transaction((tx) =>
      runtime.enqueue(
        tx,
        w,
        String(previous.versionId),
        {
          ...p,
          rootRunId: p.rootRunId ?? String(previous.id),
          recovery: previous.status === 'partial' || p.recovery,
        },
        String(previous.id),
      ),
    );
    return c.json({ id: run.id, status: run.status }, 201);
  });
  app.get('/:id', async (c) => {
    await auth(c.req.raw, 'read', c.req.param('id'));
    return c.json(await requireRow(db, Workflow, c.req.param('id')));
  });
  app.patch('/:id', async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(150).optional(),
        draft: graphSchema.optional(),
        roleId: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { user } = await auth(
      c.req.raw,
      Object.keys(body).every((k) => k === 'enabled') ? 'publish' : 'edit',
      c.req.param('id'),
    );
    const w = await requireRow(db, Workflow, c.req.param('id'));
    if (body.enabled !== undefined) {
      await auth(c.req.raw, 'publish', c.req.param('id'));
      if (body.enabled && !w.publishedVersionId) throw new Error('Publish a version first');
    }
    if (body.roleId && body.roleId !== w.roleId) {
      await auth(c.req.raw, 'assignRole', c.req.param('id'));
      // Assigning an execution identity is privileged: compare grants, including field/scope constraints.
      const own = await listPermissionsForRole(db, user.roleId ?? '');
      const target = await listPermissionsForRole(db, body.roleId);
      await requireRow(db, Role, body.roleId);
      for (const [resource, actions] of Object.entries(target))
        for (const [action, grant] of Object.entries(actions)) {
          const resources = own[resource] ?? own['*'];
          const allowed = resources?.[action] ?? resources?.['*'];
          if (
            !allowed ||
            (grant.scope === 'any' && allowed.scope !== 'any' && !own['*']?.['*']) ||
            (grant.fields === '*' && allowed.fields !== '*') ||
            (Array.isArray(grant.fields) &&
              allowed.fields !== '*' &&
              grant.fields.some((f) => !allowed.fields?.includes(f)))
          )
            throw new Error('You cannot assign a role with permissions beyond your own');
        }
    }
    return c.json(await db.transaction(async tx => {
      let serviceId = w.serviceId;
      if (body.roleId && !serviceId) {
        const identity = await insertRow(tx, User, { email: `workflow-${w.id}@service.invalid`, passwordHash:'!disabled', active:false, roleId:body.roleId });
        serviceId = identity.id;
      }
      return updateRow(tx, Workflow, String(w.id), {...body, ...(serviceId ? {serviceId} : {})});
    }));
  });
  app.post('/:id/publish', async (c) => {
    await auth(c.req.raw, 'publish', c.req.param('id'));
    return c.json(
      await db.transaction(async (tx) => {
        const w = await requireRow(tx, Workflow, c.req.param('id'));
        if (!w.roleId) throw new Error('Assign an automation role first');
        const graph = validateGraph(w.draft, runtime.registry);
        let serviceId = w.serviceId;
        if (!serviceId) {
          const identity = await insertRow(tx, User, {
            email: `workflow-${w.id}@service.invalid`,
            passwordHash: '!disabled',
            active: false,
            roleId: w.roleId,
          });
          serviceId = identity.id;
        }
        const version = await insertRow(tx, WorkflowVersion, {
          workflowId: w.id,
          graph,
          roleId: w.roleId,
          serviceId,
        });
        await updateRow(tx, Workflow, String(w.id), {
          publishedVersionId: version.id,
          serviceId,
          enabled: true,
        });
        return version;
      }),
    );
  });
  app.post('/:id/run', async (c) => {
    const { user } = await auth(c.req.raw, 'run', c.req.param('id'));
    const body = z
      .object({ draft: z.boolean().default(false), recordId: z.string().optional() })
      .parse(await c.req.json());
    return c.json(
      await db.transaction(async (tx) => {
        const w = await requireRow(tx, Workflow, c.req.param('id'));
        let v = w.publishedVersionId
          ? await requireRow(tx, WorkflowVersion, String(w.publishedVersionId))
          : null;
        if (body.draft) {
          await auth(c.req.raw, 'edit');
          if (!w.roleId || !w.serviceId)
            throw new Error('Save an automation role before testing drafts');
          v = await insertRow(tx, WorkflowVersion, {
            workflowId: w.id,
            graph: validateGraph(w.draft, runtime.registry),
            roleId: w.roleId,
            serviceId: w.serviceId,
          });
        }
        if (!v) throw new Error('Publish a version first');
        const graph = validateGraph(v.graph, runtime.registry);
        let after = null;
        if (graph.trigger.model) {
          if (!body.recordId) throw new Error('Choose a trigger record ID');
          after = await runtime.action(
            tx,
            {
              id: 'manual',
              kind: 'model',
              operation: 'read',
              label: 'Manual trigger',
              model: graph.trigger.model,
              inputs: {},
              position: { x: 0, y: 0 },
            },
            { id: body.recordId },
            { graph, roleId: String(v.roleId), serviceId: String(v.serviceId), chain: [], trigger: {} },
          );
        }
        const run = await runtime.enqueue(tx, w, String(v.id), {
          graph,
          roleId: String(v.roleId),
          serviceId: String(v.serviceId),
          chain: [String(w.id)],
          trigger: { before: null, after, changedFields: [], event: 'manual', userId: user.id },
        });
        return { id: run.id, status: run.status };
      }),
      201,
    );
  });
  app.get('/:id/runs', async (c) => {
    await auth(c.req.raw, 'viewRuns');
    await auth(c.req.raw, 'viewRuns', c.req.param('id'));
    return c.json(
      (await rows(db, WorkflowRun, sql`workflow_id = ${c.req.param('id')}`)).map(({ payload, ...r }) => r),
    );
  });
  return app;
}
