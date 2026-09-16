import type { AnyDb } from '../core/db.js';
import type { FileStorage } from '@flystorage/file-storage';
import type { ModelDefinition } from '../core/model.js';
import type { DomainDefinition } from '../core/domain.js';
import { resolveSessionToken } from '../auth/cookie.js';
import { findSessionByToken, findUserById, listPermissionsForRole, type RolePermissions, type UserRow } from '../auth/lookup.js';
import { getDomainSettings } from '../core/domain-settings-persistence.js';


export interface WebSession {
  user: UserRow;
  permissions: RolePermissions;
  /** true when the user's role owns a permission matching `(resource, action)` (either side `*`). */
  can(resource: string, action: string): boolean;
}

/**
 * The `context` every web-route `loader`/`action` receives (docs/adr/0003). Single fetch means
 * this is always available — a route handler never runs in the browser.
 */
export interface WebLoaderContext {
  db: AnyDb;
  /** the resolved session (same `ratchet_session` cookie the console/API use), or null */
  session: WebSession | null;
  /** name -> `ModelDefinition` map, as `serve.ts` builds it */
  registry: Record<string, ModelDefinition>;
  storage: FileStorage | undefined;
  /** per-request memoized Domain Settings reader — `await context.settings.get('website')` */
  settings: {
    get(domainName: string): Promise<Record<string, unknown>>;
  };
  /** throws a 401 `Response` when there is no session, a 403 when the session lacks the
   * permission — React Router routes it to the nearest `ErrorBoundary`. */
  requirePermission(resource: string, action: string): void;
}

/** Narrow a route handler's `context` (typed `unknown`/`RouterContextProvider` by React Router)
 * to Ratchet's `WebLoaderContext`. Single fetch guarantees it's always the real object. */
export function getWebContext(context: unknown): WebLoaderContext {
  return context as WebLoaderContext;
}

function permissionAllows(permissions: RolePermissions, resource: string, action: string): boolean {
  const resourceNode = permissions[resource] ?? permissions['*'];
  return resourceNode !== undefined && (resourceNode[action] ?? resourceNode['*']) !== undefined;
}

async function resolveWebSession(db: AnyDb, request: Request): Promise<WebSession | null> {
  const token = resolveSessionToken(request);
  if (!token) return null;
  const session = await findSessionByToken(db, token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = await findUserById(db, session.userId);
  if (!user || !user.active) return null;
  const permissions = typeof user.roleId === 'string' ? await listPermissionsForRole(db, user.roleId) : {};
  return {
    user,
    permissions,
    can: (resource, action) => permissionAllows(permissions, resource, action),
  };
}

export interface BuildWebContextDeps {
  db: AnyDb;
  registry: Record<string, ModelDefinition>;
  domainSettingsRegistry: Record<string, DomainDefinition>;
  storage: FileStorage | undefined;
}

export async function buildWebContext(request: Request, deps: BuildWebContextDeps): Promise<WebLoaderContext> {
  const session = await resolveWebSession(deps.db, request);

  const settingsCache = new Map<string, Promise<Record<string, unknown>>>();
  const settings = {
    get(domainName: string): Promise<Record<string, unknown>> {
      let cached = settingsCache.get(domainName);
      if (!cached) {
        const def = deps.domainSettingsRegistry[domainName];
        cached = def ? getDomainSettings(deps.db, def) : Promise.resolve({});
        settingsCache.set(domainName, cached);
      }
      return cached;
    },
  };

  return {
    db: deps.db,
    session,
    registry: deps.registry,
    storage: deps.storage,
    settings,
    requirePermission(resource, action) {
      if (!session) {
        throw new Response('Unauthorized', { status: 401 });
      }
      if (!session.can(resource, action)) {
        throw new Response('Forbidden', { status: 403 });
      }
    },
  };
}
