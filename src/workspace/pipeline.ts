import { PipelineError, type PipelineFn } from '../core/pipeline.js';
import { fetchRow } from '../core/persistence.js';
import type { UserRow } from '../auth/lookup.js';
import { Workspace } from './models/workspace.model.js';

/** Mirrors `automation/pipeline.ts`'s `assertOwnsChat` — reused both by `requireWorkspaceOwnership`
 * below and by the chat-context injection in `automation/router.ts`, which needs to check the same
 * thing before reading a workspace's views into a turn. */
export function assertOwnsWorkspace(
  workspace: Record<string, unknown> | null,
  user: UserRow,
): asserts workspace is Record<string, unknown> {
  if (!workspace || workspace.userId !== user.id) {
    throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  }
}

/** The entry-point ownership check every route already applies (`ApiModelOptions.ownerField`,
 * core/model.ts) only protects a `WorkspaceView` row's own ownership — it says nothing about
 * whether the `workspaceId` it claims to belong to is actually one of the requesting user's own
 * workspaces. This is what stops a create/update from attaching a view to (or moving it into)
 * someone else's workspace. Must run after `validate` so `ctx.input.workspaceId` is a validated
 * string.
 *
 * Also enforces the parent workspace's `locked` flag on this write — a locked workspace's views
 * can't be created/updated/removed. This check lives here, not in `assertOwnsWorkspace`, because
 * that helper is also used read-only by `automation/router.ts`'s chat-context injection, which must
 * keep working against a locked workspace. */
export const requireWorkspaceOwnership: PipelineFn = async (ctx) => {
  const workspaceId = (ctx.input as { workspaceId?: string }).workspaceId ?? (ctx.doc?.workspaceId as string | undefined);
  if (!workspaceId) return ctx;
  const workspace = await fetchRow(ctx.db, Workspace, workspaceId);
  assertOwnsWorkspace(workspace, ctx.user as unknown as UserRow);
  if (workspace.locked) {
    throw new PipelineError({ code: 'FORBIDDEN', status: 403 });
  }
  return ctx;
};
