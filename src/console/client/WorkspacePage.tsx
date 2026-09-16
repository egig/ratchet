import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { callOperation, listRows, type AuthUser } from './api.js';
import { useModels } from './models.js';
import { useAuth } from './auth.js';
import { queryKeys } from './query-keys.js';
import { WorkspaceTabs } from './WorkspaceTabs.js';
import { WorkspaceChatPanel } from './WorkspaceChatPanel.js';
import { ModelFormDialog } from './ModelFormDialog.js';
import { BrandMark } from './BrandMark.js';
import { ConsoleIcon, LockClosedIcon, LockOpenIcon, LogOutIcon, ProfileIcon } from './icons.js';
import { ThemeToggle } from './ThemeToggle.js';
import { Button } from './ui/button.js';

interface WorkspaceOption {
  id: string;
  name: string;
  locked: boolean;
  chatEnabled: boolean;
}

// shared across every workspace — the chat panel's open/closed state is a UI preference, not
// something scoped per workspace.
const CHAT_OPEN_STORAGE_KEY = 'ratchet:workspace-chat-open';

/** Avatar-only account control for the workspace header — click opens a dropdown that collapses
 * everything account-scoped (email, Edit profile, the link back to the console for root admins,
 * Log out) so the header strip itself stays down to the workspace switcher + lock toggle.
 * Mirrors `Layout`'s sidebar `AccountMenu`, anchored under the avatar rather than a sidebar footer. */
function UserMenu({
  user,
  isRoot,
  consolePath,
  onLogout,
}: {
  user: AuthUser;
  isRoot: boolean;
  consolePath: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const itemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted';

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background"
      >
        {user.email.slice(0, 2).toUpperCase()}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-border bg-surface py-1 shadow-lg">
          <p className="truncate px-3 py-1.5 text-xs text-muted-foreground">{user.email}</p>
          <Link to="/profile" onClick={() => setOpen(false)} className={itemClass}>
            <ProfileIcon className="h-4 w-4 text-muted-foreground" />
            Edit profile
          </Link>
          {isRoot && (
            <Link to={consolePath} onClick={() => setOpen(false)} className={itemClass}>
              <ConsoleIcon className="h-4 w-4 text-muted-foreground" />
              Console
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className={itemClass}
          >
            <LogOutIcon className="h-4 w-4 text-muted-foreground" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/** The workspace screen — deliberately outside `Layout` (no left sidebar): just a thin header
 * (a workspace switcher + lock toggle, with account actions — Edit profile, the console link for
 * root admins, Log out — collapsed into the avatar's `UserMenu`) over the tabs + chat two-pane
 * layout. Reads `:workspaceId` from the route (see ConsoleApp.tsx's sibling route alongside the
 * Layout route).
 *
 * Matched against `workspace/:workspaceId/*` so its own `:model/new`/`:model/:id` sub-routes
 * render the row-create/edit form as a dialog on top of this screen instead of navigating away
 * from it — the tab strip, active tab, and chat panel all stay mounted underneath. */
export function WorkspacePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { models } = useModels();
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return localStorage.getItem(CHAT_OPEN_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_OPEN_STORAGE_KEY, String(chatOpen));
    } catch {
      // ignore — e.g. private browsing with storage disabled
    }
  }, [chatOpen]);
  // `/` now redirects straight back into the workspace (`IndexRedirect.tsx`), so this link
  // targets the first sidebar model directly — otherwise the "Console" link would just loop in place.
  const consolePath = models[0] ? `/${models[0].name}` : '/';
  // mirrors the server's `hasRootAdmin` check (src/auth/lookup.ts): a `*:*` permission.
  const isRoot = user?.permissions['*']?.['*'] !== undefined;

  // the generic `/api/workspaces` GET is always owner-scoped (`api.ownerField`, create-router.ts),
  // so every row here is one the current user owns — no extra ownership check before showing the
  // lock/unlock control below.
  const listParams = useMemo(() => ({ limit: 100, offset: 0 }), []);
  const workspacesQuery = useQuery({
    queryKey: queryKeys.rows('workspaces', listParams),
    queryFn: () => listRows('workspaces', listParams).catch(() => ({ mode: 'offset' as const, rows: [], total: 0, limit: 100, offset: 0 })),
  });
  const workspaces = (workspacesQuery.data?.rows as unknown as WorkspaceOption[] | undefined) ?? null;

  const activeWorkspace = workspaces?.find((w) => w.id === workspaceId) ?? null;
  // a persistent per-workspace setting (workspace.model.ts's `chatEnabled`), distinct from the
  // per-browser `chatOpen` show/hide toggle — when off, the panel and its toggle are gone entirely.
  const chatAvailable = activeWorkspace?.chatEnabled ?? true;

  // `lock`/`unlock` are custom operations (see workspace.model.ts) — `locked` itself is no longer
  // writable via a plain PATCH (`forbidLockedInUpdate`), so this always goes through one or the
  // other by name rather than PATCHing `{ locked: !locked }`.
  const toggleLockMutation = useMutation({
    mutationFn: () => {
      if (!activeWorkspace) return Promise.resolve(null);
      return callOperation('workspaces', activeWorkspace.id, activeWorkspace.locked ? 'unlock' : 'lock');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.rows('workspaces'), exact: false }),
  });

  if (!workspaceId) return null;

  async function toggleLock() {
    await toggleLockMutation.mutateAsync();
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-muted">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <div className="flex shrink-0 items-center gap-2">
          <BrandMark />
        </div>

        <select
          value={workspaceId}
          onChange={(e) => navigate(`/workspace/${e.target.value}`)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {workspaces?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {activeWorkspace && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void toggleLock()}
              title={activeWorkspace.locked ? 'Unlock workspace' : 'Lock workspace'}
              aria-label={activeWorkspace.locked ? 'Unlock workspace' : 'Lock workspace'}
            >
              {activeWorkspace.locked ? (
                <LockClosedIcon className="h-4 w-4" />
              ) : (
                <LockOpenIcon className="h-4 w-4" />
              )}
            </Button>
          )}
          <ThemeToggle />
          {user && (
            <UserMenu user={user} isRoot={isRoot} consolePath={consolePath} onLogout={() => void logout()} />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <WorkspaceTabs
          workspaceId={workspaceId}
          refreshSignal={refreshSignal}
          chatOpen={chatOpen}
          chatAvailable={chatAvailable}
          onToggleChat={() => setChatOpen((v) => !v)}
          locked={activeWorkspace?.locked ?? false}
        />
        {chatOpen && chatAvailable && (
          <WorkspaceChatPanel workspaceId={workspaceId} onTurnDone={() => setRefreshSignal((n) => n + 1)} />
        )}
      </div>

      <Routes>
        <Route path=":model/new" element={<ModelFormDialog returnTo={`/workspace/${workspaceId}${search}`} />} />
        <Route path=":model/:id" element={<ModelFormDialog returnTo={`/workspace/${workspaceId}${search}`} />} />
      </Routes>
    </div>
  );
}
