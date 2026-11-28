import { useEffect, useState } from 'react';
import { useAui } from '@assistant-ui/react';
import { AgentPicker, useAgents } from './AgentPicker.js';
import { PlusIcon } from '@egig/ratchet/console/client';

/** The chat surface's header: a single "New chat" button that opens the {@link AgentPicker}
 * (replacing the old always-visible agent `<select>`). The picked agent is held in the parent so
 * `RemoteThreadListAdapter.initialize` can read it lazily when the first message is sent (Q4). */
export function NewChatBar({
  agentId,
  onAgentIdChange,
}: {
  agentId: string | null;
  onAgentIdChange: (id: string) => void;
}) {
  const aui = useAui();
  const { agents } = useAgents();
  const [pickerOpen, setPickerOpen] = useState(false);

  // keep the initial (pre-existing) empty thread usable without forcing a trip through the
  // dialog — the dialog is for *choosing* an agent on a new chat, not a hard gate.
  useEffect(() => {
    if (!agentId && agents[0]) onAgentIdChange(agents[0].id);
  }, [agentId, agents, onAgentIdChange]);

  function startNewChat(id: string) {
    onAgentIdChange(id);
    aui.threads.switchToNewThread();
    setPickerOpen(false);
  }

  function onNewClick() {
    if (agents.length === 1) startNewChat(agents[0]!.id);
    else setPickerOpen(true);
  }

  return (
    <div className="flex items-center gap-2 border-b border-border p-2">
      <button
        type="button"
        onClick={onNewClick}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-foreground hover:bg-muted"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        New chat
      </button>

      {pickerOpen && <AgentPicker onPick={startNewChat} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}
