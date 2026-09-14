import { useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { ChatRuntimeProvider, Thread, NewChatBar, ConnectProviderForm, useAgents } from './chat/index.js';

/** Compact thread switcher for the narrow panel — a `<select>` over every non-archived thread,
 * plus whatever is active. The console shell's `ConsoleChatPanel` reuses this same body. */
function CompactThreadSwitcher() {
  const aui = useAui();
  const items = useAuiState((s) => s.threads.threadItems);
  const mainId = useAuiState((s) => s.threads.mainThreadId);
  const active = items.filter((t) => t.status === 'regular' || t.id === mainId);
  if (active.length === 0) return null;
  return (
    <select
      value={mainId}
      onChange={(e) => aui.threads.switchToThread(e.target.value)}
      className="w-full border-b border-border bg-surface px-2 py-1 text-xs text-muted-foreground"
    >
      {active.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title || 'New chat'}
        </option>
      ))}
    </select>
  );
}

/** The shared inner body for every chat panel — `NewChatBar` (agent picker) + a compact thread
 * switcher + the assistant-ui `Thread`. Reused by `WorkspaceChatPanel` (workspace-scoped) and the
 * console shell's `ConsoleChatPanel` (no workspace) so both render the same chat UI. The
 * `ChatRuntimeProvider` wrapper differs between them, so it lives in the caller. */
export function ChatPanelBody({
  agentId,
  onAgentIdChange,
  emptyHint = 'Send a message, or start a fresh chat with “New chat”.',
}: {
  agentId: string | null;
  onAgentIdChange: (id: string) => void;
  emptyHint?: string;
}) {
  const { agents } = useAgents();
  const activeAgent = agents.find((a) => a.id === agentId);

  return (
    <>
      <NewChatBar agentId={agentId} onAgentIdChange={onAgentIdChange} />
      <CompactThreadSwitcher />
      {activeAgent && !activeAgent.providerId ? (
        <ConnectProviderForm agentId={activeAgent.id} agentName={activeAgent.name} />
      ) : (
        <div className="min-h-0 flex-1">
          <Thread emptyHint={emptyHint} />
        </div>
      )}
    </>
  );
}

export interface WorkspaceChatPanelProps {
  workspaceId: string;
  /** bumps `WorkspaceTabs`'s `refreshSignal` once a turn completes — the agent may have
   * opened/edited/closed tabs during it (Q6). */
  onTurnDone: () => void;
}

/** The workspace screen's right-side chat panel. Built on the same `ChatRuntimeProvider` /
 * `Thread` as the console shell's `ConsoleChatPanel`, laid out narrow with a compact switcher
 * instead of the full thread-list rail. `WorkspacePage` conditionally mounts this at all — the
 * open/closed toggle lives in `WorkspaceTabs`. */
export function WorkspaceChatPanel({ workspaceId, onTurnDone }: WorkspaceChatPanelProps) {
  const [agentId, setAgentId] = useState<string | null>(null);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-surface">
      <ChatRuntimeProvider agentId={agentId} workspaceId={workspaceId} onTurnFinish={onTurnDone}>
        <ChatPanelBody
          agentId={agentId}
          onAgentIdChange={setAgentId}
          emptyHint="Ask the agent about this workspace."
        />
      </ChatRuntimeProvider>
    </aside>
  );
}
