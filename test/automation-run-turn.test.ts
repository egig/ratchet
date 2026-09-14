import { describe, expect, it } from 'bun:test';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelCallOptions } from '@langchain/core/language_models/base';
import { tool } from '@langchain/core/tools';
import { runAgentTurn } from '../src/automation/run-turn.js';
import type { ChatEvent, ChatUsage } from '../src/automation/events.js';

// `runAgentTurn` normally builds its chat model from a `Provider` DB row and its tools from a
// `Role` row. Both are test-only overrides on `runAgentTurn`'s own opts (`model`, `tools`,
// `turnTimeoutMs`), and `agent.roleId: null` short-circuits `resolveAgentTools` before it touches
// `db` — so these tests need no database and no network. Tool *resolution* is covered separately
// (`automation-tools.test.ts`); here we exercise the loop's own control flow: recursion cap,
// usage accumulation, abort/timeout, stop-reason mapping, and the LangGraph→ChatEvent translator.

interface Round {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  stopReason?: string;
  usage?: { input: number; output: number };
  delayMs?: number;
}

/** A scripted `BaseChatModel`: yields `rounds[i]` on the i-th call (clamped to the last one), as
 * one assembled `AIMessage` with optional `tool_calls`, `usage_metadata`, `response_metadata`. */
class FakeChatModel extends BaseChatModel {
  rounds: Round[];
  i = 0;
  calls = 0;

  constructor(rounds: Round[], params: BaseChatModelParams = {}) {
    super(params);
    this.rounds = rounds;
  }

  _llmType() {
    return 'fake';
  }

  _combineLLMOutput() {
    return {};
  }

  // createAgent binds resolved tools here; the fake scripts its tool calls explicitly, so ignore.
  override bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[], options: BaseLanguageModelCallOptions) {
    this.calls++;
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)] ?? {};
    this.i++;

    if (round.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, round.delayMs);
        const onAbort = () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort);
      });
    }

    const callN = this.calls;
    const message = new AIMessage({
      content: round.text ?? '',
      tool_calls: (round.toolCalls ?? []).map((tc, idx) => ({
        id: `call-${callN}-${idx}`,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      })),
      usage_metadata: round.usage
        ? {
            input_tokens: round.usage.input,
            output_tokens: round.usage.output,
            total_tokens: round.usage.input + round.usage.output,
          }
        : undefined,
      response_metadata: round.stopReason ? { stop_reason: round.stopReason } : {},
    });

    return { generations: [{ text: round.text ?? '', message }], llmOutput: {} };
  }
}

function baseOpts(
  model: BaseChatModel,
  overrides: Partial<Parameters<typeof runAgentTurn>[0]> = {},
): Parameters<typeof runAgentTurn>[0] {
  return {
    agent: { name: 'test-agent', providerId: 'unused', roleId: null, model: 'test-model', systemPrompt: 'sys', config: null },
    history: [{ role: 'user', content: 'hello' }],
    db: {} as never,
    request: undefined,
    registry: {},
    model,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const usage = (inputTokens: number, outputTokens: number): ChatUsage => ({ inputTokens, outputTokens });

const echoTool = tool(async () => 'ok', {
  name: 'echo',
  description: 'echoes',
  schema: { type: 'object', properties: {} },
});

describe('runAgentTurn', () => {
  it('throws a clean error when the agent has no provider configured (opts.model unset)', async () => {
    const opts = baseOpts(new FakeChatModel([]), {
      agent: { name: 'test-agent', providerId: null, roleId: null, model: 'test-model', systemPrompt: 'sys', config: null },
      model: undefined,
    });
    await expect(collect(runAgentTurn(opts))).rejects.toThrow('has no model provider configured');
  });

  it('streams assistant text and ends on end_turn with the reported usage', async () => {
    const model = new FakeChatModel([{ text: 'Hi there', stopReason: 'end_turn', usage: { input: 5, output: 3 } }]);
    const events = await collect(runAgentTurn(baseOpts(model)));

    const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hi there');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', usage: usage(5, 3) });
  });

  it('runs a tool round and accumulates usage across model calls', async () => {
    const model = new FakeChatModel([
      { toolCalls: [{ name: 'echo', args: {} }], stopReason: 'tool_use', usage: { input: 2, output: 1 } },
      { text: 'done', stopReason: 'end_turn', usage: { input: 4, output: 2 } },
    ]);
    const events = await collect(runAgentTurn(baseOpts(model, { tools: [echoTool] })));

    const toolCall = events.find((e) => e.type === 'tool-call');
    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolCall).toMatchObject({ type: 'tool-call', call: { name: 'echo' } });
    expect(toolResult).toMatchObject({ type: 'tool-result', result: { content: 'ok' } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', usage: usage(6, 3) });
  });

  it('surfaces an error tool result and continues the loop', async () => {
    const failing = tool(
      async (_input, config) =>
        new ToolMessage({ content: 'nope', status: 'error', tool_call_id: config?.toolCall?.id ?? '' }),
      { name: 'echo', description: 'fails', schema: { type: 'object', properties: {} } },
    );
    const model = new FakeChatModel([
      { toolCalls: [{ name: 'echo', args: {} }], stopReason: 'tool_use', usage: { input: 1, output: 1 } },
      { text: 'recovered', stopReason: 'end_turn', usage: { input: 1, output: 1 } },
    ]);
    const events = await collect(runAgentTurn(baseOpts(model, { tools: [failing] })));

    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({
      type: 'tool-result',
      result: { isError: true },
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn', usage: usage(2, 2) });
  });

  it('maps a max_tokens finish to stopReason "max_tokens"', async () => {
    const model = new FakeChatModel([{ text: 'cut', stopReason: 'max_tokens', usage: { input: 1, output: 1 } }]);
    const events = await collect(runAgentTurn(baseOpts(model)));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens', usage: usage(1, 1) });
  });

  it('stops with "max_iterations" when the agent never stops calling tools', async () => {
    const model = new FakeChatModel([
      { toolCalls: [{ name: 'echo', args: {} }], stopReason: 'tool_use', usage: { input: 1, output: 1 } },
    ]);
    const events = await collect(runAgentTurn(baseOpts(model, { tools: [echoTool] })));
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_iterations' });
  });

  it('returns immediately with "aborted" if the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = new FakeChatModel([{ text: 'never' }]);
    const events = await collect(runAgentTurn(baseOpts(model, { abortSignal: ac.signal })));
    expect(events).toEqual([{ type: 'done', stopReason: 'aborted', usage: usage(0, 0) }]);
    expect(model.calls).toBe(0);
  });

  it('aborts a hung call when the caller cancels', async () => {
    const ac = new AbortController();
    const model = new FakeChatModel([{ text: 'slow', delayMs: 10_000 }]);
    const it = runAgentTurn(baseOpts(model, { abortSignal: ac.signal }))[Symbol.asyncIterator]();
    const next = it.next();
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const events: ChatEvent[] = [];
    for (let r = await next; !r.done; r = await it.next()) events.push(r.value);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'aborted', usage: usage(0, 0) });
  });

  it('yields "timeout" (distinct from "aborted") when the turn budget elapses', async () => {
    const model = new FakeChatModel([{ text: 'slow', delayMs: 10_000 }]);
    const events = await collect(runAgentTurn(baseOpts(model, { turnTimeoutMs: 20 })));
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'timeout', usage: usage(0, 0) });
  });
});
