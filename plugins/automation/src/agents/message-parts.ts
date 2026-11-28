import type { ChatMessage } from './events.js';

/**
 * The shape persisted in `Message.content` (src/automation/models/message.model.ts) — a parts
 * array in assistant-ui's `ThreadMessage` vocabulary, trimmed to what this framework produces.
 * The console's `ThreadHistoryAdapter` (src/console/client/chat/history.ts) is the only other
 * place that reads this shape.
 *
 * Only `user` and `assistant` rows are ever written. A tool call and its result live together on
 * one `tool-call` part inside the assistant row that made it — there is no separate `tool` row.
 */
export type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** the tool's stringified return (or error message) — absent only if the turn was aborted
       * before the call resolved. */
      result?: string;
      isError?: boolean;
    };

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  content: StoredPart[];
}

function textOf(parts: StoredPart[]): string {
  return parts
    .filter((p): p is Extract<StoredPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Persisted rows -> the neutral `ChatMessage[]` shape `runAgentTurn` takes (it converts these to
 * LangChain `BaseMessage`s at its own boundary). An assistant row that carried tool calls expands
 * to two messages — the assistant turn + a synthetic `tool` turn with the results. `reasoning`
 * parts are dropped — no provider round-trips them.
 */
export function storedToProviderMessages(rows: readonly StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of rows) {
    if (row.role === 'user' || row.role === 'tool') {
      out.push({ role: 'user', content: textOf(row.content) });
      continue;
    }

    const toolCalls = row.content.filter(
      (p): p is Extract<StoredPart, { type: 'tool-call' }> => p.type === 'tool-call',
    );
    const assistantText = textOf(row.content);

    if (toolCalls.length === 0) {
      out.push({ role: 'assistant', content: assistantText });
      continue;
    }

    out.push({
      role: 'assistant',
      content: assistantText,
      toolCalls: toolCalls.map((p) => ({ id: p.toolCallId, name: p.toolName, input: p.args })),
    });
    out.push({
      role: 'tool',
      content: '',
      toolResults: toolCalls.map((p) => ({
        toolCallId: p.toolCallId,
        content: p.result ?? '',
        isError: p.isError,
      })),
    });
  }
  return out;
}

/** Accumulates the assistant turn's parts as `runAgentTurn` events arrive, in the order text /
 * reasoning / tool calls first appeared, so the persisted row and the streamed UI agree. */
export class AssistantPartsBuilder {
  private parts: StoredPart[] = [];
  private textIndex: number | null = null;
  private reasoningIndex: number | null = null;
  private toolIndexById = new Map<string, number>();

  appendText(delta: string): void {
    if (this.textIndex === null) {
      this.textIndex = this.parts.push({ type: 'text', text: '' }) - 1;
    }
    (this.parts[this.textIndex] as Extract<StoredPart, { type: 'text' }>).text += delta;
  }

  appendReasoning(delta: string): void {
    if (this.reasoningIndex === null) {
      this.reasoningIndex = this.parts.push({ type: 'reasoning', text: '' }) - 1;
    }
    (this.parts[this.reasoningIndex] as Extract<StoredPart, { type: 'reasoning' }>).text += delta;
  }

  addToolCall(call: { id: string; name: string; input: unknown }): void {
    // a fresh text/reasoning part starts after a tool call, matching assistant-ui's part ordering
    this.textIndex = null;
    this.reasoningIndex = null;
    const index = this.parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      args: call.input,
    }) - 1;
    this.toolIndexById.set(call.id, index);
  }

  setToolResult(toolCallId: string, result: string, isError: boolean | undefined): void {
    const index = this.toolIndexById.get(toolCallId);
    if (index === undefined) return;
    const part = this.parts[index] as Extract<StoredPart, { type: 'tool-call' }>;
    part.result = result;
    if (isError) part.isError = true;
  }

  build(): StoredPart[] {
    return this.parts;
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }
}
