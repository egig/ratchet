import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { AssistantRuntimeProvider, useAui, useRemoteThreadListRuntime, type AssistantRuntime } from '@assistant-ui/react';
import { useDataStreamRuntime } from '@assistant-ui/react-data-stream';
import { useChatThreadListAdapter } from './thread-list-adapter.js';

export interface ChatRuntimeProviderProps {
  /** null until the "new chat" affordance picks one — `RemoteThreadListAdapter.initialize`
   * reads it lazily (Q4). */
  agentId: string | null;
  /** when embedded in `WorkspaceChatPanel`: sent in the turn request body so the server can
   * prepend a workspace-tabs snapshot to that one model call (Q5). */
  workspaceId?: string;
  /** controlled active thread (the standalone page syncs this to the URL). */
  threadId?: string;
  onThreadIdChange?: (threadId: string | undefined) => void;
  /** fired after a turn finishes streaming — used to refetch workspace tabs the agent may have
   * changed, and to reload the authoritative message rows (Q6, Q13). */
  onTurnFinish?: () => void;
  children: ReactNode;
}

export function ChatRuntimeProvider({
  agentId,
  workspaceId,
  threadId,
  onThreadIdChange,
  onTurnFinish,
  children,
}: ChatRuntimeProviderProps) {
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const onTurnFinishRef = useRef(onTurnFinish);
  onTurnFinishRef.current = onTurnFinish;
  // set after the runtime is built; read inside `onFinish` to refresh the thread list (titles /
  // ordering) once a turn completes.
  const runtimeRef = useRef<AssistantRuntime | null>(null);

  const adapter = useChatThreadListAdapter({ getAgentId: () => agentIdRef.current });

  const runtimeHook = useCallback(() => {
    /* eslint-disable react-hooks/rules-of-hooks -- assistant-ui calls this as a hook */
    const aui = useAui();
    return useDataStreamRuntime({
      api: '/api/automation/chat',
      credentials: 'same-origin',
      // `useDataStreamRuntime` only forwards `unstable_threadId`, which is the *local* thread id
      // under `useRemoteThreadListRuntime` and is absent for a brand-new thread. Resolve the real
      // chat id here instead: `initialize()` is idempotent — it returns the existing remoteId or
      // runs our `RemoteThreadListAdapter.initialize` (which creates the `Chat`) on the first turn.
      body: async () => {
        const { remoteId } = await aui.threadListItem.initialize();
        return workspaceIdRef.current
          ? { threadId: remoteId, workspaceId: workspaceIdRef.current }
          : { threadId: remoteId };
      },
      onFinish: () => {
        void runtimeRef.current?.threads.reload();
        onTurnFinishRef.current?.();
      },
    });
    /* eslint-enable react-hooks/rules-of-hooks */
  }, []);

  const runtime = useRemoteThreadListRuntime(
    useMemo(
      () => ({ runtimeHook, adapter, threadId, onThreadIdChange }),
      [runtimeHook, adapter, threadId, onThreadIdChange],
    ),
  );
  runtimeRef.current = runtime;

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
