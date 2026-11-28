import type { AnyDb } from '../core/db.js';
import { PipelineError } from '../core/pipeline.js';
import { insertRow, updateRow } from '../core/persistence.js';
import { Workspace, DEFAULT_WORKSPACE_NAME } from '../workspace/index.js';
import type { PluginSetupInfo } from '../plugin/types.js';
import { User, Role } from './models/index.js';
import { findRoleByName, hasRootAdmin, listPermissionsForRole } from './lookup.js';
import { writeCredentialPassword } from './pipeline.js';

const ROOT_ROLE_NAME = 'Root';

/** One-time bootstrap: creates the first user with unrestricted (`*:*`) access, so a fresh
 * instance has a way in without a DB console. Re-checks `hasRootAdmin` inside the transaction so
 * a concurrent double-submit can't create two. Becomes a permanent 409 once any user holds `*:*`,
 * regardless of that user's `active` state (see `hasRootAdmin`'s doc comment).
 *
 * Then runs `onSetup` — every plugin's setup hook (`RatchetPlugin.onSetup`), inside the same
 * transaction, so a plugin can seed its own first rows (e.g. the automation plugin's default
 * agent holding the Root role) atomically with the admin itself.
 *
 * Shared by `POST /api/auth/setup` (`src/auth/router.ts`) and the `ratchet create-admin` CLI
 * command (`src/cli/commands/create-admin.ts`) — the latter is production's only bootstrap path,
 * since `/setup` 404s unconditionally there. */
export async function provisionRootAdmin(
  db: AnyDb,
  params: { email: string; password: string },
  onSetup?: (info: PluginSetupInfo) => Promise<void>,
): Promise<Record<string, unknown>> {
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

    // Lowercased the way better-auth normalizes every email it stores and looks up — otherwise a
    // mixed-case address provisioned here could never sign in through `/sign-in/email`.
    const user = await insertRow(tx, User, { email: params.email.trim().toLowerCase(), name: '', roleId: role.id });
    await writeCredentialPassword(tx, user.id as string, params.password);
    // the freshly-created `Root` role above has no workspaceTemplateId yet, so this is always the
    // blank default — see `workspace/provisioning.ts`'s `createDefaultWorkspace`, which this
    // mirrors for the one user-creation path that doesn't run through a pipe().
    await insertRow(tx, Workspace, { userId: user.id, name: DEFAULT_WORKSPACE_NAME });
    await onSetup?.({ tx, rootRoleId: role.id as string, userId: user.id as string });

    return user;
  });
}
