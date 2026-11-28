import { apiRequest as request } from '@egig/ratchet/console/client';

// Chat endpoints of the plugin's `/api/automation` router (../agents/router.ts).

export interface ChatSummary {
  id: string;
  agentId: string;
  title: string | null;
  status: 'active' | 'archived';
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  /** assistant-ui message parts (see `../agents/message-parts.ts`) — decoded by
   * `./chat/history.ts`. */
  content: unknown[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** `RemoteThreadListAdapter.list()`. */
export function listChats(): Promise<ChatSummary[]> {
  return request('/api/automation/chats');
}

/** `RemoteThreadListAdapter.initialize()` — creates a bare chat (no message, no stream). */
export function createChat(input: { agentId: string; title?: string }): Promise<{ id: string }> {
  return request('/api/automation/chats', { method: 'POST', body: JSON.stringify(input) });
}

/** `rename` / `archive` / `unarchive`. */
export function patchChat(chatId: string, input: { title?: string; status?: 'active' | 'archived' }): Promise<unknown> {
  return request(`/api/automation/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteChat(chatId: string): Promise<unknown> {
  return request(`/api/automation/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
}

/** history `load()`. */
export function listChatMessages(chatId: string): Promise<ChatMessageRow[]> {
  return request(`/api/automation/chats/${encodeURIComponent(chatId)}/messages`);
}
