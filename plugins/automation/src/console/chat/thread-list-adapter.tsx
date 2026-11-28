import { useCallback, useEffect, useMemo, useRef, type FC, type PropsWithChildren } from 'react';
import {
  RuntimeAdapterProvider,
  type RemoteThreadListAdapter,
} from '@assistant-ui/react';
import { createAssistantStream } from 'assistant-stream';
import { createChat, deleteChat, listChats, patchChat } from '../api.js';
import { useChatHistoryAdapter } from './history.js';

export interface ChatThreadListAdapterOptions {
  /** the agent the next `initialize()` should attach the new chat to — read lazily so the
   * console's "new chat" agent picker can change it without re-creating the adapter (Q4). */
  getAgentId: () => string | null;
}

/**
 * Backs assistant-ui's thread list with `/api/automation/chats/*`. Mirrors the shape of
 * `useCloudThreadListAdapter` (node_modules/@assistant-ui/core) — `unstable_useAdapters` /
 * `unstable_Provider` inject the per-thread history + model-context adapters.
 */
export function useChatThreadListAdapter(options: ChatThreadListAdapterOptions): RemoteThreadListAdapter {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const useAdapters = useCallback(function useChatAdapters() {
    const history = useChatHistoryAdapter();
    return useMemo(() => ({ history }), [history]);
  }, []);

  const unstable_Provider = useCallback<FC<PropsWithChildren>>(function Provider({ children }) {
    const adapters = useAdapters();
    return <RuntimeAdapterProvider adapters={adapters}>{children}</RuntimeAdapterProvider>;
  }, [useAdapters]);

  return useMemo<RemoteThreadListAdapter>(() => ({
    async list() {
      const chats = await listChats();
      return {
        threads: chats.map((c) => ({
          status: c.status === 'archived' ? 'archived' : 'regular',
          remoteId: c.id,
          title: c.title ?? undefined,
          lastMessageAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
          // surfaced in the chat header (`Thread` → `ChatAgentHeader`).
          custom: { agentId: c.agentId },
        })),
      };
    },
    async initialize(threadId) {
      const agentId = optionsRef.current.getAgentId();
      if (!agentId) throw new Error('pick an agent before starting a chat');
      const { id } = await createChat({ agentId });
      return { remoteId: id, externalId: threadId };
    },
    async rename(remoteId, title) {
      await patchChat(remoteId, { title });
    },
    async archive(remoteId) {
      await patchChat(remoteId, { status: 'archived' });
    },
    async unarchive(remoteId) {
      await patchChat(remoteId, { status: 'active' });
    },
    async delete(remoteId) {
      await deleteChat(remoteId);
    },
    async generateTitle() {
      // no auto-title generation (Q15) — the thread list runtime still requires this method,
      // so hand it an immediately-closed stream.
      return createAssistantStream(async (c) => {
        c.close();
      });
    },
    async fetch(threadId) {
      const chats = await listChats();
      const chat = chats.find((c) => c.id === threadId);
      return {
        status: chat?.status === 'archived' ? 'archived' : 'regular',
        remoteId: threadId,
        title: chat?.title ?? undefined,
        custom: chat ? { agentId: chat.agentId } : undefined,
      };
    },
    unstable_Provider,
    unstable_useAdapters: useAdapters,
  }), [unstable_Provider, useAdapters]);
}
