import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from './router.js';
import { useModels } from './models.js';
import { listRows, createRow, updateRow, removeRow, type OffsetPage } from './api.js';
import { queryKeys } from './query-keys.js';
import { WorkspaceViewTable, type WorkspaceViewRow } from './WorkspaceViewTable.js';
import { Dialog } from './Dialog.js';
import { FilterBar, sanitizeFilters, type FilterNode } from './FilterBar.js';
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SparklesIcon, XMarkIcon } from './icons.js';
import { Button } from './ui/button.js';

export interface WorkspaceTabsProps {
  workspaceId: string;
  /** bumped by the parent (`WorkspacePage`) when the side panel reports a change, so this
   * refetches — e.g. an agent in the automation plugin's chat opened/edited/closed tabs via its
   * workspace-view tools during a turn (tool calls aren't reflected live, mid-turn). */
  refreshSignal: number;
  /** the plugin side panel (`ConsolePlugin.workspacePanel`) toggle, or `null` when no plugin fills
   * that slot or the workspace's `chatEnabled` setting is off — the button is then dropped
   * entirely. It lives here, in the tab strip's row, rather than inside the panel itself, since a
   * fully-hidden panel wouldn't have anywhere to put a re-open control. */
  panelToggle: { open: boolean; label: string; icon?: ComponentType<{ className?: string }>; onToggle: () => void } | null;
  /** the active workspace's `locked` flag — while true, tabs are frozen (no add/reorder/close) and
   * the active tab's `FilterBar` is hidden; the rows a tab shows stay fully interactive, only the
   * set of tabs and their queries are frozen. */
  locked: boolean;
}

/** The tab strip + active tab's content for one workspace — add/reorder/close tabs, all backed by
 * plain `workspace_views` rows through the generic (now owner-scoped) `/api/:model` router. */
export function WorkspaceTabs({
  workspaceId,
  refreshSignal,
  panelToggle,
  locked,
}: WorkspaceTabsProps) {
  const queryClient = useQueryClient();
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // the tab whose label is currently being edited inline (double-click), and the in-progress text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  // set by Escape so the input's own onBlur (fired as it unmounts) skips the save.
  const cancelRenameRef = useRef(false);
  // the active tab's view id is mirrored into `?tab=` so a page refresh (or a link straight to a
  // workspace URL) restores the same tab instead of always falling back to the first one.
  const [searchParams, setSearchParams] = useSearchParams();
  // set by a just-completed add/reorder mutation to steer which tab becomes active once the
  // list's refetch resolves — consumed (reset to undefined) the first time it's used.
  const preferredIdRef = useRef<string | undefined>(undefined);

  const listParams = useMemo(
    () => ({ limit: 100, offset: 0, filters: [['workspaceId', '=', workspaceId]] as FilterNode[], sort: 'order' }),
    [workspaceId],
  );

  const viewsQuery = useQuery({
    queryKey: queryKeys.rows('workspace_views', listParams),
    queryFn: () => listRows('workspace_views', listParams),
  });
  const views = (viewsQuery.data?.rows as unknown as WorkspaceViewRow[] | undefined) ?? null;
  const loadError =
    viewsQuery.error instanceof Error ? viewsQuery.error.message : viewsQuery.error ? 'failed to load tabs' : null;

  function setActiveId(id: string | null) {
    setActiveIdState(id);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('tab', id);
        else next.delete('tab');
        return next;
      },
      { replace: true },
    );
  }

  // resolves the active tab whenever the fetched list changes — a just-created/-moved tab wins
  // via `preferredIdRef`, otherwise the current selection is kept if it still exists, otherwise
  // this falls back to `?tab=` (a deep link) and finally the first tab.
  useEffect(() => {
    if (!views) return;
    const wanted = preferredIdRef.current ?? activeId ?? searchParams.get('tab');
    const resolved = views.some((v) => v.id === wanted) ? wanted! : (views[0]?.id ?? null);
    preferredIdRef.current = undefined;
    setActiveId(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.rows('workspace_views', listParams) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  function refetchViews() {
    return queryClient.invalidateQueries({ queryKey: queryKeys.rows('workspace_views', listParams) });
  }

  const addTabMutation = useMutation({
    mutationFn: (input: { targetModel: string; label: string; filters: FilterNode[] }) => {
      const order = (views?.reduce((max, v) => Math.max(max, v.order), -1) ?? -1) + 1;
      return createRow('workspace_views', {
        workspaceId,
        targetModel: input.targetModel,
        label: input.label,
        filters: input.filters,
        order,
      });
    },
    onSuccess: async (created) => {
      preferredIdRef.current = (created as unknown as WorkspaceViewRow).id;
      setShowAddDialog(false);
      await refetchViews();
    },
  });

  const closeTabMutation = useMutation({
    mutationFn: (id: string) => removeRow('workspace_views', id),
    onSuccess: () => refetchViews(),
  });

  const moveMutation = useMutation({
    mutationFn: async ({ id, direction }: { id: string; direction: -1 | 1 }) => {
      if (!views) return;
      const idx = views.findIndex((v) => v.id === id);
      const swapWith = views[idx + direction];
      if (!swapWith) return;
      const current = views[idx]!;
      await Promise.all([
        updateRow('workspace_views', current.id, { order: swapWith.order }),
        updateRow('workspace_views', swapWith.id, { order: current.order }),
      ]);
      preferredIdRef.current = id;
    },
    onSuccess: () => refetchViews(),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => updateRow('workspace_views', id, { label }),
    onSuccess: () => refetchViews(),
  });

  async function addTab(input: { targetModel: string; label: string; filters: FilterNode[] }) {
    await addTabMutation.mutateAsync(input);
  }

  async function closeTab(id: string) {
    await closeTabMutation.mutateAsync(id);
  }

  function startRename(view: WorkspaceViewRow) {
    if (locked) return;
    setEditingId(view.id);
    setDraftLabel(view.label);
  }

  async function commitRename(id: string) {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const next = draftLabel.trim();
    setEditingId(null);
    const current = views?.find((v) => v.id === id);
    if (!current || !next || next === current.label) return;
    await renameMutation.mutateAsync({ id, label: next });
  }

  async function move(id: string, direction: -1 | 1) {
    await moveMutation.mutateAsync({ id, direction });
  }

  const active = views?.find((v) => v.id === activeId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-border">
        {views?.map((v, i) => (
          <div
            key={v.id}
            className={`flex items-center gap-1 rounded-t border border-b-0 px-3 py-1.5 text-sm ${
              v.id === activeId
                ? 'border-border bg-surface font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {editingId === v.id ? (
              <input
                autoFocus
                type="text"
                maxLength={255}
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                onBlur={() => void commitRename(v.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(v.id);
                  else if (e.key === 'Escape') {
                    cancelRenameRef.current = true;
                    setEditingId(null);
                  }
                }}
                // borderless / zero-padding so swapping the label button for this input doesn't
                // resize the tab — it sits in the exact box the label text occupied, just editable.
                className="w-28 bg-transparent p-0 text-sm font-medium text-foreground underline decoration-border outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setActiveId(v.id)}
                onDoubleClick={() => startRename(v)}
                title={locked ? undefined : 'Double-click to rename'}
              >
                {v.label}
              </button>
            )}
            {!locked && (
              <>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => void move(v.id, -1)}
                  aria-label="Move tab left"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronLeftIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={i === views.length - 1}
                  onClick={() => void move(v.id, 1)}
                  aria-label="Move tab right"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void closeTab(v.id)}
                  aria-label="Close tab"
                  className="ml-1 text-muted-foreground hover:text-destructive"
                >
                  <XMarkIcon className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
        ))}

        {!locked && (
          <div className="ml-2 pb-1">
            <button
              type="button"
              onClick={() => setShowAddDialog(true)}
              className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add tab
            </button>
          </div>
        )}

        {panelToggle && (
          <div className="ml-auto pb-1">
            <button
              type="button"
              onClick={panelToggle.onToggle}
              title={panelToggle.label}
              aria-label={panelToggle.label}
              aria-pressed={panelToggle.open}
              className={`flex h-7 w-7 items-center justify-center rounded ${
                panelToggle.open ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {panelToggle.icon ? <panelToggle.icon className="h-4 w-4" /> : <SparklesIcon className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>

      {loadError && <p className="mb-3 text-sm text-destructive">{loadError}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {active ? (
          <WorkspaceViewTable
            key={active.id}
            view={active}
            workspaceId={workspaceId}
            locked={locked}
            onChange={(next) =>
              queryClient.setQueryData(queryKeys.rows('workspace_views', listParams), (prev: OffsetPage | undefined) =>
                prev
                  ? { ...prev, rows: prev.rows.map((r) => (r.id === next.id ? (next as unknown as Record<string, unknown>) : r)) }
                  : prev,
              )
            }
          />
        ) : (
          views && views.length === 0 && <p className="text-sm text-muted-foreground">No tabs yet — add one above.</p>
        )}
      </div>

      {showAddDialog && <AddTabDialog onClose={() => setShowAddDialog(false)} onCreate={(input) => void addTab(input)} />}
    </div>
  );
}

/** Add-tab dialog: pick a target model, then optionally scope it with a filter clause built
 * through the same `FilterBar` used to edit an existing tab's filters — so a tab can start out
 * already narrowed instead of always opening onto the model's full, unfiltered row set. */
function AddTabDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { targetModel: string; label: string; filters: FilterNode[] }) => void;
}) {
  const { models, getModel } = useModels();
  const [targetModel, setTargetModel] = useState('');
  // tracks whether the user has typed their own label yet — until they do, it follows the
  // selected model's label so picking a model alone is still enough to add a tab.
  const [label, setLabel] = useState('');
  const [labelEdited, setLabelEdited] = useState(false);
  const [filters, setFilters] = useState<FilterNode[]>([]);
  const model = targetModel ? getModel(targetModel) : undefined;

  return (
    <Dialog onClose={onClose}>
      <h2 className="mb-4 text-base font-semibold text-foreground">Add tab</h2>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Model</label>
          <select
            value={targetModel}
            onChange={(e) => {
              const next = e.target.value;
              setTargetModel(next);
              setFilters([]);
              if (!labelEdited) setLabel(getModel(next)?.label ?? '');
            }}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <option value="">Select a model…</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">Tab name</label>
          <input
            type="text"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setLabelEdited(true);
            }}
            placeholder="e.g. Open orders"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          />
        </div>

        {model && (
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">Initial filters</label>
            <FilterBar fields={model.fields} value={filters} onChange={setFilters} />
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          <XMarkIcon className="h-4 w-4" />
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!model || !label.trim()}
          onClick={() => model && onCreate({ targetModel: model.name, label: label.trim(), filters: sanitizeFilters(filters) })}
        >
          <PlusIcon className="h-4 w-4" />
          Add tab
        </Button>
      </div>
    </Dialog>
  );
}
