/**
 * The internal streaming vocabulary between `run-turn.ts` and `router.ts`.
 *
 * `run-turn.ts` drives LangChain's `createAgent` and translates its stream into this small union;
 * `router.ts` + `message-parts.ts` consume only these events. LangChain types (`BaseChatModel`,
 * `BaseMessage`, …) never cross this boundary — they live exclusively in `run-turn.ts` and
 * `model-factory.ts`. That quarantine is what keeps the HTTP layer, persistence, and the console
 * client free of the LLM stack.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12-ish subset). Passed straight to LangChain's `tool({ schema })`. */
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * A single conversation turn in the neutral shape `message-parts.ts` produces from persisted
 * rows. `run-turn.ts` converts these to LangChain `BaseMessage`s at its own boundary — nothing
 * else touches LangChain message types.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  /** empty string for an assistant turn that only made tool calls. */
  content: string;
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
}

export type ChatStopReason =
  | 'end_turn'
  // retained for type-compat; `createAgent` never terminates a turn here (it was only ever a
  // transient between-iteration state under the old hand-rolled loop).
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'aborted'
  // `run-turn.ts` caught LangGraph's `GraphRecursionError` — the agent kept calling tools past
  // the recursion limit without a final answer. Distinct from `max_tokens` (a real length
  // cutoff from the provider) so the console can label it accurately.
  | 'max_iterations'
  // the turn's wall-clock budget elapsed while waiting on the provider.
  | 'timeout';

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; call: ChatToolCall }
  // emitted by `runAgentTurn` (not by the model) once it has executed a tool call it previously
  // surfaced — carries the same `toolCallId` so the console can pair them.
  | { type: 'tool-result'; result: ChatToolResult }
  | { type: 'done'; stopReason: ChatStopReason; usage: ChatUsage };
