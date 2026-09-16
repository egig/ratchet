import { defineModel, field, pipe, validate, persist, requireOwnsRow, PipelineError, type PipelineFn } from '../../core/index.js';
import { presetFields } from '../../auth/pipeline.js';

/** Blocks writes to a `locked` workspace — its structure (its own fields, and via
 * `requireWorkspaceOwnership` in workspace/pipeline.ts, its `WorkspaceView` tabs) is frozen, e.g. so
 * a `Role`-provisioned workspace can be handed to someone who should only work with the data
 * inside it (see workspace-view.model.ts). No carve-out needed for `locked` itself anymore — see
 * `forbidLockedInUpdate` below, `locked` never reaches `update` in the first place, so unlocking a
 * locked row (via the `unlock` operation) never has to pass through this check at all. Must run
 * after `requireOwnsRow` so a non-owner still gets 404, not 403. */
export const requireNotLocked: PipelineFn = (ctx) => {
  if (ctx.doc?.locked) {
    throw new PipelineError({ code: 'FORBIDDEN', status: 403 });
  }
  return ctx;
};

/** `locked` is only ever written by the `lock`/`unlock` operations below — never by a plain
 * `update` — so there's exactly one path to change lock state, and exactly one permission pair
 * that grants it (`resource:lock`/`resource:unlock`, not `resource:update` + `field:locked` alone;
 * see [Custom Operations](/guide/custom-operations)'s two-gate permission model). Must run before
 * `validate` so a `locked` key in the request body is rejected outright rather than silently
 * accepted (or silently dropped, which would let a client believe it changed lock state when it
 * didn't). */
export const forbidLockedInUpdate: PipelineFn = (ctx) => {
  if ('locked' in ctx.input) {
    throw new PipelineError({
      code: 'VALIDATION_ERROR',
      status: 400,
      fields: { locked: "can't be set via update — use the 'lock'/'unlock' operation instead" },
    });
  }
  return ctx;
};

/**
 * A named collection of `WorkspaceView` tabs (workspace-view.model.ts), owned by exactly one
 * user. Unlike `Chat`/`Message` (src/automation/models), this stays reachable through the generic
 * `/api/:model` router — `api: { ownerField: 'userId' }` is what keeps that safe (create-router.ts
 * auto-scopes every read to the requesting user, `requireOwnsRow` below scopes every write) rather
 * than needing a dedicated router.
 *
 * `lock`/`unlock` are [custom operations](/guide/custom-operations) built on `presetFields` — the
 * framework's worked example for the "convenient action that's really a specific write" pattern
 * (a `lock`/`unlock` button in the console instead of exposing `locked` as an editable form field).
 * Each still runs `requireOwnsRow('userId')` first (composed the same way `create`/`update`/
 * `remove` already do — `api.ownerField` alone only scopes reads, not writes), nested inside the
 * operation's own `pipe(...)` around `presetFields`'s internal `pipe(validate, persist)`.
 */
export const Workspace = defineModel('workspaces', {
  fields: {
    userId: field.reference('users', { required: true, indexed: true, displayText: 'Owner' }),
    name: field.string({ required: true, maxLength: 255 }),
    locked: field.boolean({ default: false }),
    // when false, `WorkspacePage` drops the agent chat panel (and its show/hide toggle)
    // entirely for this workspace — a persistent setting, not the per-browser hide toggle.
    chatEnabled: field.boolean({ default: true }),
  },
  operations: {
    create: pipe(requireOwnsRow('userId'), validate, persist),
    update: pipe(requireOwnsRow('userId'), requireNotLocked, validate, persist),
    remove: pipe(requireOwnsRow('userId'), requireNotLocked, persist.remove),
    lock: {
      pipeline: pipe(requireOwnsRow('userId'), presetFields({ locked: true })),
      console: { label: 'Lock workspace', visibleWhen: { field: 'locked', equals: false } },
    },
    unlock: {
      pipeline: pipe(requireOwnsRow('userId'), presetFields({ locked: false })),
      console: { label: 'Unlock workspace', visibleWhen: { field: 'locked', equals: true } },
    },
  },
  console: { label: 'Workspaces', displayField: 'name' },
  api: { ownerField: 'userId' },
});
