import type { AnyDb } from '../core/db.js';
import { createAgent } from 'langchain';
import { GraphRecursionError } from '@langchain/langgraph';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type ToolRunnableConfig } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ModelDefinition } from '../core/index.js';
import { fetchRow } from '../core/persistence.js';
import { createChatModel } from './model-factory.js';
import { resolveAgentTools, executeAgentTool, type AgentTool } from './tool.js';
import { Provider } from './models/index.js';
import type { ChatEvent, ChatMessage, ChatStopReason, ChatUsage } from './events.js';


// One tool-use round is two LangGraph super-steps (model node + tools node). Cap at 8 rounds like
// the old hand-rolled loop: 2 * 8 + 1 for the trailing model call that produces the final answer.
const RECURSION_LIMIT = 2 * 8 + 1;

// Generous wall-clock budget for one whole turn (all tool-use rounds included) — bounds a hung
// provider connection, which otherwise holds the request open indefinitely. LangGraph has no
// wall-clock primitive, so this stays a plain `setTimeout` that trips the run's `AbortSignal`.
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** neutral persisted-history shape (`events.ts` `ChatMessage`) -> LangChain messages. The system
 * prompt is *not* in here — it goes to `createAgent({ systemPrompt })` separately. */
function toLangChainMessages(history: ChatMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push(new HumanMessage(m.content));
    } else if (m.role === 'assistant') {
      out.push(
        new AIMessage({
          content: m.content,
          tool_calls: (m.toolCalls ?? []).map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: (typeof tc.input === 'object' && tc.input !== null ? tc.input : {}) as Record<string, unknown>,
            type: 'tool_call' as const,
          })),
        }),
      );
    } else {
      for (const r of m.toolResults ?? []) {
        out.push(
          new ToolMessage({
            content: r.content,
            tool_call_id: r.toolCallId,
            status: r.isError ? 'error' : undefined,
          }),
        );
      }
    }
  }
  return out;
}

/** Wraps each RBAC-resolved `AgentTool` as a LangChain tool. `executeAgentTool` is called
 * unchanged — it still runs every call through the target model's pipeline, re-authenticated as
 * the chatting user (`ctx.request`). Errors are caught and returned as an error `ToolMessage` so
 * the turn continues, exactly as the old loop fed a tool error back to the model. */
function toLangChainTools(
  agentTools: AgentTool[],
  ctx: { db: AnyDb; request: Request | undefined; registry: Record<string, ModelDefinition> },
) {
  return agentTools.map((t) =>
    tool(
      async (input: Record<string, unknown>, config?: ToolRunnableConfig) => {
        try {
          const out = await executeAgentTool(t, input, ctx);
          return typeof out === 'string' ? out : JSON.stringify(out);
        } catch (err) {
          // return an error `ToolMessage` (not throw) so the turn continues, and carry the call
          // id from `config.toolCall` so `router.ts` can pair it with the tool-call part.
          return new ToolMessage({
            content: err instanceof Error ? err.message : String(err),
            status: 'error',
            tool_call_id: config?.toolCall?.id ?? '',
          });
        }
      },
      { name: t.spec.name, description: t.spec.description, schema: t.spec.parameters },
    ),
  );
}

function extractText(msg: BaseMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Reasoning/thinking deltas — Anthropic streams them as `thinking` content blocks; some models
 * put them on `additional_kwargs.reasoning_content`. */
function extractReasoning(msg: BaseMessage): string {
  const parts: string[] = [];
  if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      const block = p as { type?: string; thinking?: string; reasoning?: string };
      if (block.type === 'thinking' && block.thinking) parts.push(block.thinking);
      else if (block.type === 'reasoning' && block.reasoning) parts.push(block.reasoning);
    }
  }
  const rc = (msg.additional_kwargs?.reasoning_content ?? '') as string;
  if (typeof rc === 'string' && rc) parts.push(rc);
  return parts.join('');
}

/** final `response_metadata` (Anthropic `stop_reason`, OpenAI `finish_reason`) -> `ChatStopReason`. */
function mapStopReason(meta: Record<string, unknown> | undefined): ChatStopReason {
  const raw = (meta?.stop_reason ?? meta?.finish_reason) as string | undefined;
  if (raw === 'max_tokens' || raw === 'length') return 'max_tokens';
  if (raw === 'refusal' || raw === 'content_filter') return 'refusal';
  return 'end_turn';
}

/**
 * Runs one user turn against an `Agent` row to completion, including any tool-use rounds — a plain
 * async generator over `ChatEvent`. Wraps LangChain's `createAgent` (the v1 ReAct agent); the
 * LangChain stack is imported only here and in `model-factory.ts`. `request` is the chat's own
 * HTTP request, forwarded unchanged into every granted tool call (`src/automation/tool.ts`) so
 * each one re-authenticates and re-checks permissions as the same user who's chatting — a tool
 * call can never do more than that user could already do over the REST API.
 */
export async function* runAgentTurn(opts: {
  agent: Record<string, unknown>;
  history: ChatMessage[];
  db: AnyDb;
  request: Request | undefined;
  registry: Record<string, ModelDefinition>;
  /** the chat request's own signal — a client hitting stop ends the turn cleanly (the router
   * still persists whatever streamed, with `stopReason: 'aborted'`). An already-dispatched tool
   * call is not rolled back. */
  abortSignal?: AbortSignal;
  /** test-only seam: bypasses the `Provider` row / `createChatModel` lookup and uses this model
   * directly. Never set by production callers (`router.ts`). Lets the loop's own control flow
   * (recursion cap, usage accumulation, abort/timeout, stop-reason mapping) be unit-tested with a
   * fake `BaseChatModel` instead of a live LLM API. */
  model?: BaseChatModel;
  /** test-only override for `TURN_TIMEOUT_MS`. */
  turnTimeoutMs?: number;
  /** test-only seam: skip `resolveAgentTools` + `toLangChainTools` and hand `createAgent` these
   * LangChain tools directly. Never set by production callers — tool *resolution* is covered by
   * `automation-tools.test.ts`; this lets the loop's control flow be tested without a DB. */
  tools?: Parameters<typeof createAgent>[0]['tools'];
}): AsyncGenerator<ChatEvent> {
  const { agent, abortSignal } = opts;

  let model: BaseChatModel;
  if (opts.model) {
    model = opts.model;
  } else {
    if (!agent.providerId) {
      throw new Error(`agent '${agent.name as string}' has no model provider configured`);
    }
    const providerRow = await fetchRow(opts.db, Provider, agent.providerId as string);
    if (!providerRow) {
      throw new Error(`agent '${agent.name as string}' references a provider that no longer exists`);
    }
    model = createChatModel(
      {
        kind: providerRow.kind as string,
        apiKey: providerRow.apiKey as string,
        url: (providerRow.url as string | null) ?? undefined,
      },
      { model: agent.model as string, config: (agent.config as Record<string, unknown> | null) ?? undefined },
    );
  }

  let lcTools = opts.tools;
  if (!lcTools) {
    const agentTools = await resolveAgentTools(opts.db, opts.registry, agent.roleId as string | null);
    lcTools = toLangChainTools(agentTools, {
      db: opts.db,
      request: opts.request,
      registry: opts.registry,
    });
  }

  let totalUsage: ChatUsage = { inputTokens: 0, outputTokens: 0 };

  if (abortSignal?.aborted) {
    yield { type: 'done', stopReason: 'aborted', usage: totalUsage };
    return;
  }

  const callController = new AbortController();
  const onCallerAbort = () => callController.abort();
  abortSignal?.addEventListener('abort', onCallerAbort);
  const timer = setTimeout(() => callController.abort(), opts.turnTimeoutMs ?? TURN_TIMEOUT_MS);

  const agentGraph = createAgent({
    model,
    tools: lcTools,
    systemPrompt: agent.systemPrompt as string,
  });

  // last assistant `response_metadata` seen — mapped to a `ChatStopReason` once the run ends.
  let lastResponseMeta: Record<string, unknown> | undefined;
  const seenToolCallIds = new Set<string>();

  try {
    const stream = await agentGraph.stream(
      { messages: toLangChainMessages(opts.history) },
      { streamMode: ['messages', 'updates'], signal: callController.signal, recursionLimit: RECURSION_LIMIT },
    );

    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === 'messages') {
        // [messageChunk, metadata] — token-level text/reasoning only; assembled tool calls and
        // usage come from `updates` so nothing is double-counted.
        const [msg] = chunk as [BaseMessage, unknown];
        const text = extractText(msg);
        if (text) yield { type: 'text-delta', text };
        const reasoning = extractReasoning(msg);
        if (reasoning) yield { type: 'thinking-delta', text: reasoning };
        continue;
      }

      // mode === 'updates' — { <node>: { messages: [...] } } after each node completes.
      for (const update of Object.values(chunk as Record<string, { messages?: BaseMessage[] } | undefined>)) {
        for (const m of update?.messages ?? []) {
          if (m instanceof AIMessage) {
            const um = m.usage_metadata;
            if (um) totalUsage = addUsage(totalUsage, { inputTokens: um.input_tokens, outputTokens: um.output_tokens });
            if (m.response_metadata && Object.keys(m.response_metadata).length > 0) {
              lastResponseMeta = m.response_metadata;
            }
            for (const tc of m.tool_calls ?? []) {
              const id = tc.id ?? '';
              if (seenToolCallIds.has(id)) continue;
              seenToolCallIds.add(id);
              yield { type: 'tool-call', call: { id, name: tc.name, input: tc.args } };
            }
          } else if (m instanceof ToolMessage) {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            yield {
              type: 'tool-result',
              result: { toolCallId: m.tool_call_id, content, isError: m.status === 'error' },
            };
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof GraphRecursionError) {
      yield { type: 'done', stopReason: 'max_iterations', usage: totalUsage };
      return;
    }
    if (callController.signal.aborted) {
      yield { type: 'done', stopReason: abortSignal?.aborted ? 'aborted' : 'timeout', usage: totalUsage };
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onCallerAbort);
  }

  if (callController.signal.aborted) {
    yield { type: 'done', stopReason: abortSignal?.aborted ? 'aborted' : 'timeout', usage: totalUsage };
    return;
  }

  yield { type: 'done', stopReason: mapStopReason(lastResponseMeta), usage: totalUsage };
}
