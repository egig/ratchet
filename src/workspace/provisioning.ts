import type { PipelineFn } from '../core/pipeline.js';
import { fetchRow, insertRow, listRowsByField } from '../core/persistence.js';
import { Role } from '../auth/models/role.model.js';
import { Workspace } from './models/workspace.model.js';
import { WorkspaceView } from './models/workspace-view.model.js';

/** Name given to every newly-provisioned `Workspace` — see `createDefaultWorkspace` below. Kept
 * in its own module (not `pipeline.ts`) because `workspace-view.model.ts` already imports
 * `pipeline.ts` for `requireWorkspaceOwnership` — importing `WorkspaceView` back into
 * `pipeline.ts` would make that a real import cycle. */
export const DEFAULT_WORKSPACE_NAME = 'My Workspace';

/** Copies every `WorkspaceView` under `templateWorkspaceId` into `targetWorkspaceId`, owned by
 * `userId` — the label/filter/sort/include/limit/order shape of each tab, minus the template's
 * own id/workspaceId/userId. */
async function cloneWorkspaceViews(
  ctx: Parameters<PipelineFn>[0],
  templateWorkspaceId: string,
  targetWorkspaceId: string,
  userId: string,
): Promise<void> {
  const templateViews = await listRowsByField(ctx.db, WorkspaceView, 'workspaceId', templateWorkspaceId);
  for (const view of templateViews) {
    await insertRow(
      ctx.db,
      WorkspaceView,
      {
        userId,
        workspaceId: targetWorkspaceId,
        targetModel: view.targetModel,
        label: view.label,
        filters: view.filters,
        sort: view.sort,
        include: view.include,
        limit: view.limit,
        order: view.order,
      },
      userId,
    );
  }
}

/**
 * Composed onto the end of `User`'s `create` pipelines (`auth/models/user.model.ts`'s
 * `User.operations.create` and `registerPipeline`) so every new account starts with somewhere to
 * open workspace views/chat, instead of the console's workspace switcher (WorkspacePage.tsx)
 * showing empty until the user creates one by hand. Reads `ctx.doc.id` — the just-persisted
 * `User` row's id — rather than `ctx.user`, since `registerPipeline` runs unauthenticated (no
 * `ctx.user` yet) and self-creates the account it should provision for. Runs post-commit (after
 * `persist`, the pipeline's write boundary — core/pipeline.ts), so a failure here can't roll back
 * the user creation itself, and non-transactionally, so it can't be folded into the same insert.
 *
 * When the new user has a `roleId` (`auth/models/user.model.ts`) whose `Role` names a
 * `workspaceTemplateId` (`auth/models/role.model.ts`), that template's `WorkspaceView` tabs are
 * cloned onto the new workspace, so the user lands on a view suited to their role. Both are
 * optional (e.g. a self-registered account has no `roleId` yet, and a permissions-only role may
 * have no template), so a blank workspace stays the common case for `/register`. The workspace is
 * always named `DEFAULT_WORKSPACE_NAME` regardless of role.
 */
export const createDefaultWorkspace: PipelineFn = async (ctx) => {
  const userId = ctx.doc?.id;
  if (typeof userId !== 'string') return ctx;

  const roleId = ctx.doc?.roleId;
  const role = typeof roleId === 'string' ? await fetchRow(ctx.db, Role, roleId) : null;

  const workspace = await insertRow(ctx.db, Workspace, { userId, name: DEFAULT_WORKSPACE_NAME }, userId);

  if (typeof role?.workspaceTemplateId === 'string') {
    await cloneWorkspaceViews(ctx, role.workspaceTemplateId, workspace.id as string, userId);
  }

  return ctx;
};
