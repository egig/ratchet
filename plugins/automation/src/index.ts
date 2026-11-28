import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineDomain } from '@egig/ratchet/core';
import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type RatchetPlugin } from '@egig/ratchet/plugin';
import { Agent, Chat, Message, Provider } from './agents/models/index.js';
import { createAutomationRouter } from './agents/router.js';
import { Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, WorkflowOutbox } from './workflows/models.js';
import { WorkflowRuntime } from './workflows/runtime.js';
import { createInngestAdapter } from './workflows/inngest.js';
import { createWorkflowRouter } from './workflows/router.js';
import type { WorkflowConfig } from './workflows/config.js';

export { Agent, Chat, Message, Provider } from './agents/models/index.js';
export { Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, WorkflowOutbox } from './workflows/models.js';
export { resolveAgentTools, executeAgentTool } from './agents/tool.js';
export type { AgentTool, ToolContext } from './agents/tool.js';
export { createChatModel } from './agents/model-factory.js';
export type { ChatEvent, ChatMessage, ChatStopReason, ChatToolCall, ChatToolResult, ChatUsage, ToolSpec } from './agents/events.js';
export type { WorkflowConfig } from './workflows/config.js';
export type { WorkflowAdapter, DurableSteps } from './workflows/adapter.js';
export { validateGraph, defaultGraph } from './workflows/graph.js';
export type { Graph, WorkflowNode, Binding } from './workflows/graph.js';

/** The Automation Domain. Its `chats`/`messages` models are `console: { hidden: true }` — chat is
 * surfaced through the plugin's console side panels instead (see `./console/agents`). No settings
 * of its own; it exists so the plugin's models stay grouped in the sidebar. */
export const AutomationDomain = defineDomain('automation', {});

export interface AutomationOptions {
  /** Agents + chat: the `/api/automation` router and the console chat panels. Default `true`. */
  agents?: boolean;
  /** Workflows: the `/api/workflows` router (Inngest-backed) and the console workflow editor.
   * Omit to leave workflows off. */
  workflows?: WorkflowConfig;
}

const RATCHET_AGENT_NAME = 'Ratchet';
const RATCHET_SYSTEM_PROMPT =
  "You are Ratchet, this instance's built-in assistant. You hold the Root role, so every model " +
  'and operation this app exposes is available to you as a tool — use that access thoughtfully on ' +
  "the requesting user's behalf.";

/** this package's own directory — `src/` when running from source, `dist/` when installed */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The automation plugin — agents, chat and workflows. Add it to `ratchet.config.ts`:
 *
 * ```ts
 * import { automation } from '@egig/ratchet-automation';
 * export default defineConfig({ ..., plugins: [automation({ workflows: { adapter: 'inngest', appId: 'my-app' } })] });
 * ```
 *
 * Every model (agents and workflows alike) is always registered, whatever the toggles — so turning
 * a feature off or on never changes the schema. The toggles only control routers and console UI.
 */
export function automation(opts: AutomationOptions = {}): RatchetPlugin {
  const agents = opts.agents ?? true;
  const workflows = opts.workflows;
  // one runtime per assembled app (the same plugin object can back several `createRatchetApp`
  // calls — tests, `ratchet create-admin`), keyed by that app's context
  const runtimes = new WeakMap<PluginContext, WorkflowRuntime>();

  return definePlugin({
    name: 'automation',
    apiVersion: PLUGIN_API_VERSION,
    module: '@egig/ratchet-automation',
    domain: 'automation',
    models: { Provider, Agent, Chat, Message, Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, WorkflowOutbox },
    domains: { AutomationDomain },
    optional: ['workspace'],

    decorateDb: workflows
      ? (db, ctx) => {
          const runtime = new WorkflowRuntime(db, ctx.models, workflows, ctx.kit);
          runtime.adapter = createInngestAdapter(runtime);
          runtimes.set(ctx, runtime);
          // every router sees mutations through the runtime, so published workflows trigger
          return runtime.observe();
        }
      : undefined,

    routes: (ctx) => {
      const runtime = runtimes.get(ctx);
      return [
        ...(agents ? [{ prefix: '/api/automation', app: createAutomationRouter(ctx) }] : []),
        ...(runtime ? [{ prefix: '/api/workflows', app: createWorkflowRouter(runtime) }] : []),
      ];
    },

    // the instance's first agent holds the Root role, so it can call every tool from turn one.
    // `providerId` starts null — connecting a model provider happens from the chat panel.
    onSetup: async ({ tx, rootRoleId }, ctx) => {
      await ctx.kit.data.insertRow(tx, Agent, {
        name: RATCHET_AGENT_NAME,
        systemPrompt: RATCHET_SYSTEM_PROMPT,
        providerId: null,
        roleId: rootRoleId,
      });
    },

    console: [
      ...(agents ? ['@egig/ratchet-automation/console/agents'] : []),
      ...(workflows ? ['@egig/ratchet-automation/console/workflows'] : []),
    ],
    consoleStyles: {
      source: path.join(PACKAGE_DIR, 'console'),
      css: workflows ? [path.join(PACKAGE_DIR, 'console', 'styles.css')] : [],
    },
  });
}
