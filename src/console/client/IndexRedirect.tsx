import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from './router.js';
import { listRows } from './api.js';
import { queryKeys } from './query-keys.js';

interface WorkspaceOption {
  id: string;
}

/** The console root itself has no dashboard — land on the signed-in user's own `Workspace` (every
 * account is provisioned one on creation, see `workspace/provisioning.ts`'s
 * `createDefaultWorkspace`), so login/setup drop straight into it. `sort: 'createdAt'` picks the
 * oldest one deterministically when a user has more than one. Falls back to the `workspaces`
 * create form for an account with none (e.g. one created before default-workspace provisioning
 * existed) — `Workspace` is a framework built-in, always registered, so `/workspaces/new` is
 * always a valid route, unlike a fallback onto some consumer app's own first sidebar model. */
export function IndexRedirect() {
  const listParams = useMemo(() => ({ limit: 1, offset: 0, sort: 'createdAt' }), []);
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.rows('workspaces', listParams),
    queryFn: () => listRows('workspaces', listParams),
  });

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;

  const workspaceId = (data?.rows[0] as unknown as WorkspaceOption | undefined)?.id ?? null;
  if (workspaceId) return <Navigate to={`/workspace/${workspaceId}`} replace />;
  return <Navigate to="/workspaces/new" replace />;
}
