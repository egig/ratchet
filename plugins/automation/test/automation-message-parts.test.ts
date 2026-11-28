import { describe, expect, it } from 'bun:test';
import {
  AssistantPartsBuilder,
  storedToProviderMessages,
  type StoredMessage,
} from '../src/agents/message-parts.js';

describe('storedToProviderMessages', () => {
  it('maps a plain user/assistant exchange', () => {
    const rows: StoredMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ];
    expect(storedToProviderMessages(rows)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('concatenates multiple text parts in a row', () => {
    const rows: StoredMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    ];
    expect(storedToProviderMessages(rows)).toEqual([{ role: 'assistant', content: 'ab' }]);
  });

  it('drops reasoning parts (no adapter round-trips them)', () => {
    const rows: StoredMessage[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking...' }, { type: 'text', text: 'answer' }] },
    ];
    expect(storedToProviderMessages(rows)).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('expands an assistant row with tool calls into an assistant + synthetic tool message', () => {
    const rows: StoredMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'tc_1', toolName: 'create_widgets', args: { name: 'x' }, result: '{"id":"w1"}' },
        ],
      },
    ];
    expect(storedToProviderMessages(rows)).toEqual([
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'tc_1', name: 'create_widgets', input: { name: 'x' } }],
      },
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'tc_1', content: '{"id":"w1"}', isError: undefined }],
      },
    ]);
  });

  it('carries a tool-call error through and tolerates a missing result (aborted mid-call)', () => {
    const rows: StoredMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'tc_2', toolName: 'remove_widgets', args: { id: 'w1' }, result: 'boom', isError: true },
          { type: 'tool-call', toolCallId: 'tc_3', toolName: 'list_widgets', args: {} },
        ],
      },
    ];
    const [, toolMsg] = storedToProviderMessages(rows);
    expect(toolMsg).toEqual({
      role: 'tool',
      content: '',
      toolResults: [
        { toolCallId: 'tc_2', content: 'boom', isError: true },
        { toolCallId: 'tc_3', content: '', isError: undefined },
      ],
    });
  });
});

describe('AssistantPartsBuilder', () => {
  it('accumulates text and reasoning deltas into single parts', () => {
    const b = new AssistantPartsBuilder();
    b.appendReasoning('think');
    b.appendReasoning('ing');
    b.appendText('ans');
    b.appendText('wer');
    expect(b.build()).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('starts a fresh text part after a tool call and pairs results by id', () => {
    const b = new AssistantPartsBuilder();
    b.appendText('before');
    b.addToolCall({ id: 'tc_1', name: 'create_widgets', input: { a: 1 } });
    b.setToolResult('tc_1', '{"ok":true}', undefined);
    b.appendText('after');
    expect(b.build()).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool-call', toolCallId: 'tc_1', toolName: 'create_widgets', args: { a: 1 }, result: '{"ok":true}' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('marks an errored tool result', () => {
    const b = new AssistantPartsBuilder();
    b.addToolCall({ id: 'tc_9', name: 'remove_widgets', input: {} });
    b.setToolResult('tc_9', 'nope', true);
    expect(b.build()).toEqual([
      { type: 'tool-call', toolCallId: 'tc_9', toolName: 'remove_widgets', args: {}, result: 'nope', isError: true },
    ]);
  });

  it('ignores a result for an unknown tool-call id', () => {
    const b = new AssistantPartsBuilder();
    b.appendText('hi');
    b.setToolResult('missing', 'x', undefined);
    expect(b.build()).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('reports emptiness (nothing streamed -> no row persisted)', () => {
    expect(new AssistantPartsBuilder().isEmpty()).toBe(true);
    const b = new AssistantPartsBuilder();
    b.appendText('x');
    expect(b.isEmpty()).toBe(false);
  });
});
