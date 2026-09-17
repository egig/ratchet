import { Inngest } from 'inngest';
import { serve } from 'inngest/edge';
import { updateRow } from '../core/persistence.js';
import { WorkflowRun } from './models.js';
import type { WorkflowRuntime } from './runtime.js';
import type { WorkflowAdapter, DurableSteps } from './adapter.js';

export function createInngestAdapter(runtime: WorkflowRuntime): WorkflowAdapter {
  const c = runtime.config;
  const client = new Inngest({
    id: c.appId,
    eventKey: c.eventKey,
    signingKey: c.signingKey,
    baseUrl: c.baseUrl,
    isDev: c.isDev,
  });
  const execute = client.createFunction(
    {
      id: 'ratchet-workflow',
      triggers: [{ event: 'ratchet/workflow.run' }],
      retries: 3,
      concurrency: { limit: 1, key: 'event.data.rootRunId' },
      onFailure: async ({ event }) => {
        const runId = event.data.event.data.runId;
        if (typeof runId === 'string')
          await updateRow(runtime.db, WorkflowRun, runId, {
            status: 'failed',
            error: 'Execution failed after retries; inspect step details.',
          });
      },
    },
    async ({ event, step }) => runtime.execute(String(event.data.runId), step as unknown as DurableSteps),
  );
  const sweep = client.createFunction(
    { id: 'ratchet-workflow-outbox', triggers: [{ cron: '* * * * *' }] },
    async ({ step }) => step.run('dispatch', () => runtime.dispatch()),
  );
  const handler = serve({ client, functions: [execute, sweep], servePath: '/api/workflows/inngest' });
  return {
    dispatch: async (runId) => {
      const { requireRow } = await import('./runtime.js');
      const run = await requireRow(runtime.db, WorkflowRun, runId);
      const payload = run.payload as { rootRunId?: string };
      await client.send({
        id: runId,
        name: 'ratchet/workflow.run',
        data: { runId, rootRunId: payload.rootRunId ?? runId },
      });
    },
    handle: (request) => handler(request),
  };
}
