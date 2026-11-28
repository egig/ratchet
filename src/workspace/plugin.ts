import type { AnyDb } from '../core/db.js';
import type { UserRow } from '../auth/lookup.js';
import { fetchRow } from '../core/persistence.js';
import { listRows } from '../router/list.js';
import { definePlugin, PLUGIN_API_VERSION } from '../plugin/types.js';
import { Workspace, WorkspaceView } from './models/index.js';
import { assertOwnsWorkspace } from './pipeline.js';

/** A workspace and its view tabs, as one plain JSON snapshot. */
export interface WorkspaceSnapshot {
  workspace: { id: unknown; name: unknown };
  views: Array<Record<string, unknown>>;
}

/** What other plugins reach as `ctx.plugins.workspace` (soft-depend on it: `optional: ['workspace']`). */
export interface WorkspaceService {
  /** The requester's own workspace + its tabs. 404s (`PipelineError`) when it isn't theirs. */
  snapshot(db: AnyDb, workspaceId: string, user: UserRow): Promise<WorkspaceSnapshot>;
}

/**
 * Workspace through the plugin contract. Only the service seam lives here for now — the
 * `Workspace`/`WorkspaceView` models, the user-creation provisioning hook and the console screen
 * are still core built-ins until workspace is extracted into its own package.
 */
export const workspacePlugin = definePlugin({
  name: 'workspace',
  apiVersion: PLUGIN_API_VERSION,
  service: (): WorkspaceService => ({
    async snapshot(db, workspaceId, user) {
      const workspace = await fetchRow(db, Workspace, workspaceId);
      assertOwnsWorkspace(workspace, user);
      const views = await listRows(db, WorkspaceView, {}, {
        limit: 100,
        offset: 0,
        sort: [{ field: 'order', direction: 'asc' }],
        cursorMode: false,
        includeDeleted: false,
        include: [],
        filters: [{ field: 'workspaceId', op: '=', value: workspaceId }],
      });
      return {
        workspace: { id: workspace.id, name: workspace.name },
        views: views.rows.map((v) => ({
          id: v.id,
          label: v.label,
          targetModel: v.targetModel,
          filters: v.filters,
          sort: v.sort,
          include: v.include,
          limit: v.limit,
          order: v.order,
        })),
      };
    },
  }),
});
