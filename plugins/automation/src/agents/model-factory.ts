import { ChatAnthropic, type AnthropicInput } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Builds the LangChain chat model for one turn from a `Provider` row + its `Agent`. Together with
 * `run-turn.ts` this is the *only* place the LangChain stack is imported — everything downstream
 * (router, persistence, console) speaks the neutral `ChatEvent`/`ChatMessage` vocabulary in
 * `events.ts`.
 *
 * `kind` picks the wrapper:
 *  - `anthropic` → `ChatAnthropic`. Adaptive thinking + effort + ephemeral prompt caching are all
 *    first-class on `@langchain/anthropic` (`thinking` / `outputConfig` / `cache_control`).
 *  - `openai` → `ChatOpenAI` on the chat-completions API, `configuration.baseURL` set from the
 *    provider's `url`. Covers OpenAI itself plus every OpenAI-compatible host (Groq, Together,
 *    Fireworks, OpenRouter, local vLLM/Ollama, …), exactly as the old hand-rolled adapter did.
 *
 * `Agent.config` stays an arbitrary passthrough bag: recognised keys (`effort`, `thinking`,
 * `maxTokens`) are mapped to typed options; anything else is forwarded verbatim
 * (`invocationKwargs` for Anthropic, `modelKwargs` for OpenAI) so a new provider parameter never
 * needs a framework change.
 */

const ANTHROPIC_MAX_TOKENS = 64000;
const MAX_RETRIES = 3;

type Kind = 'anthropic' | 'openai';

export interface ChatModelSource {
  kind: string;
  apiKey: string;
  /** base-URL override — only meaningful to the openai-compatible path. */
  url?: string | null;
}

const KNOWN_CONFIG_KEYS = new Set(['effort', 'thinking', 'maxTokens']);

function splitConfig(config: Record<string, unknown> | null | undefined): {
  effort: unknown;
  thinking: unknown;
  maxTokens: unknown;
  rest: Record<string, unknown>;
} {
  const c = config ?? {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!KNOWN_CONFIG_KEYS.has(k)) rest[k] = v;
  }
  return { effort: c.effort, thinking: c.thinking, maxTokens: c.maxTokens, rest };
}

export function createChatModel(source: ChatModelSource, agent: {
  model: string;
  config?: Record<string, unknown> | null;
}): BaseChatModel {
  const kind = source.kind as Kind;
  const { effort, thinking, maxTokens, rest } = splitConfig(agent.config);

  if (kind === 'anthropic') {
    return new ChatAnthropic({
      model: agent.model,
      apiKey: source.apiKey,
      ...(source.url ? { anthropicApiUrl: source.url } : {}),
      maxTokens: typeof maxTokens === 'number' ? maxTokens : ANTHROPIC_MAX_TOKENS,
      maxRetries: MAX_RETRIES,
      // adaptive by default (matches the old adapter); override the whole object via config.thinking.
      thinking: (thinking as AnthropicInput['thinking']) ?? { type: 'adaptive' },
      // `output_config.effort` / top-level `cache_control` are per-call options, not constructor
      // fields — forward them (and any unrecognised config key) as raw API params. `cache_control`
      // makes the API apply an advancing ephemeral cache breakpoint across turns automatically.
      invocationKwargs: {
        output_config: { effort: typeof effort === 'string' ? effort : 'high' },
        cache_control: { type: 'ephemeral' },
        ...rest,
      },
    });
  }

  if (kind === 'openai') {
    return new ChatOpenAI({
      model: agent.model,
      apiKey: source.apiKey,
      maxRetries: MAX_RETRIES,
      ...(source.url ? { configuration: { baseURL: source.url } } : {}),
      ...(Object.keys(rest).length > 0 ? { modelKwargs: rest } : {}),
    });
  }

  throw new Error(`unknown provider kind '${source.kind}' — expected 'anthropic' or 'openai'`);
}
