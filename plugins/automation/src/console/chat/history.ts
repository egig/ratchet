import { useEffect, useRef, useState } from 'react';
import {
  ExportedMessageRepository,
  useAui,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';

type MessageContent = ThreadMessageLike['content'];
import { listChatMessages, type ChatMessageRow } from '../api.js';

/**
 * `Message.content` parts as persisted by `src/automation/message-parts.ts` — the console never
 * writes these (the server is authoritative, Q13), it only decodes them for `load()`.
 */
type StoredPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args?: unknown; result?: unknown; isError?: boolean };

function rowToThreadMessage(row: ChatMessageRow): ThreadMessageLike {
  const parts = Array.isArray(row.content) ? (row.content as StoredPart[]) : [];
  const content = parts.map((p) => {
    if (p.type === 'tool-call') {
      return {
        type: 'tool-call' as const,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: (p.args ?? {}) as Record<string, unknown>,
        result: p.result,
        isError: p.isError,
      };
    }
    return p;
  }) as MessageContent;
  const fallback: MessageContent = [{ type: 'text', text: '' }];
  return {
    role: row.role === 'user' ? 'user' : 'assistant',
    content: content.length > 0 ? content : fallback,
    id: row.id,
    createdAt: row.createdAt ? new Date(row.createdAt) : undefined,
    metadata: row.metadata ? { custom: row.metadata } : undefined,
  };
}

/**
 * A `ThreadHistoryAdapter` that only loads. Persistence is server-side: `POST /api/automation/chat`
 * writes both the user and the assistant row (Q13), so `append`/`update` here are deliberate
 * no-ops — assistant-ui calls them optimistically and the authoritative rows arrive on the next
 * `load()` after `onFinish` invalidates the query.
 */
export function useChatHistoryAdapter(): ThreadHistoryAdapter {
  const aui = useAui();
  const auiRef = useRef(aui);
  useEffect(() => {
    auiRef.current = aui;
  });

  const [adapter] = useState<ThreadHistoryAdapter>(() => ({
    async load() {
      const item = auiRef.current.threadListItem;
      const remoteId = item.source ? item.getState().remoteId : undefined;
      if (!remoteId) return { messages: [] };
      const rows = await listChatMessages(remoteId);
      return ExportedMessageRepository.fromArray(rows.map(rowToThreadMessage));
    },
    async append() {
      /* server-authoritative — see doc comment */
    },
  }));

  return adapter;
}
