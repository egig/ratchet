import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '../Dialog.js';
import { listRows } from '../api.js';
import { queryKeys } from '../query-keys.js';
import { Button } from '../ui/button.js';

export interface AgentOption {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  providerId: string | null;
}

/** React Query hook for the agents list — shared by `AgentPicker`, `NewChatBar`, and the chat
 * header. `agents` is active-only (what you can start a chat with); `nameById` covers every agent
 * (including deactivated ones a past chat may still reference). */
export function useAgents(): {
  agents: AgentOption[];
  nameById: Map<string, string>;
  loading: boolean;
  error: string | null;
} {
  const listParams = useMemo(() => ({ limit: 100, offset: 0, sort: 'name' }), []);
  const query = useQuery({
    queryKey: queryKeys.rows('agents', listParams),
    queryFn: () => listRows('agents', listParams),
  });
  const all = (query.data?.rows as unknown as AgentOption[] | undefined) ?? [];
  const nameById = new Map(all.map((a) => [a.id, a.name]));
  const error = query.error instanceof Error ? query.error.message : query.error ? 'failed to load agents' : null;
  return { agents: all.filter((a) => a.active), nameById, loading: query.isLoading, error };
}

/** Modal shown when starting a new chat — pick which agent answers it (Q4/Q8 follow-up: the
 * choice is captured before `RemoteThreadListAdapter.initialize` runs). */
export function AgentPicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const { agents, loading, error } = useAgents();

  return (
    <Dialog onClose={onClose}>
      <h2 className="mb-1 text-base font-semibold text-foreground">New chat</h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose an agent to talk to.</p>

      {loading && <p className="text-sm text-muted-foreground">Loading agents…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No active agents. Create one under <span className="font-medium">Automation → Agents</span> first.
        </p>
      )}

      <div className="max-h-96 space-y-1 overflow-y-auto">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(a.id)}
            className="flex w-full flex-col items-start rounded-md border border-border px-3 py-2 text-left hover:border-muted-foreground hover:bg-muted"
          >
            <span className="text-sm font-medium text-foreground">{a.name}</span>
            {a.description && <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{a.description}</span>}
          </button>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
