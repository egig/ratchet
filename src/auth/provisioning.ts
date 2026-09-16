import type { AnyDb } from '../core/db.js';
import { PipelineError } from '../core/pipeline.js';
import { insertRow, updateRow } from '../core/persistence.js';
import { Workspace, DEFAULT_WORKSPACE_NAME } from '../workspace/index.js';
import { Agent } from '../automation/models/index.js';
import { User, Role } from './models/index.js';
import { findRoleByName, hasRootAdmin, listPermissionsForRole } from './lookup.js';
import { hashPassword } from './password.js';

const ROOT_ROLE_NAME = 'Root';
const RATCHET_AGENT_NAME = 'Ratchet';
const RATCHET_SYSTEM_PROMPT =
  "You are Ratchet, this instance's built-in assistant. You hold the Root role, so every model " +
  'and operation this app exposes is available to you as a tool — use that access thoughtfully on ' +
  "the requesting user's behalf.";

/** One-time bootstrap: creates the first user with unrestricted (`*:*`) access, so a fresh
 * instance has a way in without a DB console. Re-checks `hasRootAdmin` inside the transaction so
 * a concurrent double-submit can't create two. Becomes a permanent 409 once any user holds `*:*`,
 * regardless of that user's `active` state (see `hasRootAdmin`'s doc comment).
 *
 * Also provisions the framework's first built-in `Agent` — named `Ratchet`, `roleId` set to the
 * same Root role, so it can call every tool from turn one (docs/guide/auth.md's "Agents derive
 * their tools from a `Role`"). `Agent.providerId` starts out `null`: connecting a Model Provider
 * is a separate step, done from the chat UI's empty-state (or the Providers admin screen), not
 * part of provisioning the root admin.
 *
 * Shared by `POST /api/auth/setup` (`src/auth/router.ts`) and the `ratchet create-admin` CLI
 * command (`src/cli/commands/create-admin.ts`) — the latter is production's only bootstrap path,
 * since `/setup` 404s unconditionally there. */
export async function provisionRootAdmin(db: AnyDb, params: { email: string; password: string }): Promise<Record<string, unknown>> {
  return db.transaction(async (tx) => {
    if (await hasRootAdmin(tx)) {
      throw new PipelineError({ code: 'SETUP_ALREADY_COMPLETE', status: 409, message: 'a root admin already exists' });
    }

    const role = (await findRoleByName(tx, ROOT_ROLE_NAME)) ?? (await insertRow(tx, Role, { name: ROOT_ROLE_NAME }));
    const permissions = await listPermissionsForRole(tx, role.id as string);
    if (permissions['*']?.['*'] === undefined) {
      // `fields: '*'` isn't optional here even though `action: '*'` already implies the fieldless
      // `remove` action — field-level permission is checked independently of action-level
      // (docs/content/docs/auth.mdx), so an explicit fields value is still required for the
      // field-shaped actions ('*' covers read/create/update too). Without it, secure-by-default
      // field permission would brick the console immediately after setup: the root admin could
      // log in but see/write no fields on any model, with no way to grant the first field
      // permission. `scope: 'any'` isn't optional either — every model now has a default owner
      // (`createdById`, `core/pipeline.ts`'s `ownerFieldOf`) and an unspecified `scope` defaults
      // to `'own'`, so without this Root would only ever see/manage rows it personally created,
      // not the unrestricted access the role is meant to grant. Replaces the whole tree rather
      // than appending alongside it: the "no mixing '*' with specific resource keys" rule
      // (`validateRolePermissions`) means a `'*'` grant can never coexist with whatever
      // specific-resource grants an existing `Root` role might already carry — and `*:*` already
      // implies every one of them anyway.
      await updateRow(tx, Role, role.id as string, { permissions: { '*': { '*': { fields: '*', scope: 'any' } } } });
    }

    const user = await insertRow(tx, User, { email: params.email, passwordHash: await hashPassword(params.password), roleId: role.id });
    // the freshly-created `Root` role above has no workspaceTemplateId yet, so this is always the
    // blank default — see `workspace/provisioning.ts`'s `createDefaultWorkspace`, which this
    // mirrors for the one user-creation path that doesn't run through a pipe().
    await insertRow(tx, Workspace, { userId: user.id, name: DEFAULT_WORKSPACE_NAME });
    await insertRow(tx, Agent, { name: RATCHET_AGENT_NAME, systemPrompt: RATCHET_SYSTEM_PROMPT, providerId: null, roleId: role.id });

    return user;
  });
}
