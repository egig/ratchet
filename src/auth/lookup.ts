import { sql } from 'drizzle-orm';
import type { AnyDb } from '../core/db.js';
import { rowToCamelCase } from '../core/naming.js';


/**
 * Raw `sql` queries against the built-in auth tables, deliberately independent of
 * `ModelDefinition`/`persistence.ts` — `src/auth/models/*.model.ts` reference these pipeline
 * fns (`requireAuth`/`requirePermission`) inside their own `operations` config, so resolving a
 * lookup through the model objects themselves would be circular. Table/column names are the
 * framework's own fixed built-in schema, not derived from user models.
 */

export interface SessionRow {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
}

export async function findSessionByToken(db: AnyDb, token: string): Promise<SessionRow | null> {
  const rows = await db.execute(
    sql`SELECT id, user_id, token, expires_at FROM sessions WHERE token = ${token} AND deleted_at IS NULL LIMIT 1`,
  );
  return rows[0] ? (rowToCamelCase(rows[0]) as unknown as SessionRow) : null;
}

export async function insertSession(db: AnyDb, id: string, userId: string, token: string, expiresAt: Date, now: Date): Promise<SessionRow> {
  const rows = await db.execute(
    sql`INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at, created_by_id)
        VALUES (${id}, ${userId}, ${token}, ${expiresAt.toISOString()}, ${now.toISOString()}, ${now.toISOString()}, ${userId})
        RETURNING id, user_id, token, expires_at`,
  );
  const row = rows[0];
  if (!row) throw new Error('insertSession: insert returned no row');
  return rowToCamelCase(row) as unknown as SessionRow;
}

export async function deleteSessionByToken(db: AnyDb, token: string): Promise<void> {
  await db.run(sql`DELETE FROM sessions WHERE token = ${token}`);
}

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  roleId: string | null;
  active: boolean;
}

export async function findUserById(db: AnyDb, id: string): Promise<UserRow | null> {
  const rows = await db.execute(
    sql`SELECT id, email, password_hash, role_id, active FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`,
  );
  return rows[0] ? (rowToCamelCase(rows[0]) as unknown as UserRow) : null;
}

export async function findUserByEmail(db: AnyDb, email: string): Promise<UserRow | null> {
  const rows = await db.execute(
    sql`SELECT id, email, password_hash, role_id, active FROM users WHERE email = ${email} AND deleted_at IS NULL LIMIT 1`,
  );
  return rows[0] ? (rowToCamelCase(rows[0]) as unknown as UserRow) : null;
}

/** One resource+action node's grant, e.g. `permissions.documents.update`. `fields` names which
 * columns are readable/writable for a field-shaped action (`read`/`create`/`update`/`'*'`) —
 * `'*'` for every field, an array for an explicit list, `undefined` for a fieldless action
 * (`remove`, or a custom operation) which has no field concept at all. `scope` restricts the
 * grant to rows the requester owns (`'own'`) or every row (`'any'`) — only meaningful (and only
 * valid, per `validateRolePermissions`) on a resource whose model declares `api.ownerField`. */
export interface ActionGrant {
  fields?: '*' | string[];
  scope?: 'own' | 'any';
}

/** `Role.permissions`'s shape: `resource -> action -> grant`. Either key may be `'*'` — but never
 * alongside a sibling specific key at that same level (`validateRolePermissions` enforces this at
 * write time): a resource/action grouping is either fully wildcard or fully enumerated, never
 * mixed, so the most-specific-key-wins lookup (`lookupActionGrant`, ratchet/auth) never has to
 * merge two sources of truth. */
export type RolePermissions = Record<string, Record<string, ActionGrant>>;

/** Reads one role's entire grant tree off its `permissions` jsonb column (`Role.permissions`,
 * src/auth/models/role.model.ts) — no junction table. Defaults to `{}` (no grants at all) for a
 * user with no role. */
export async function listPermissionsForRole(db: AnyDb, roleId: string): Promise<RolePermissions> {
  const rows = await db.execute(
    sql`SELECT permissions FROM roles WHERE id = ${roleId} AND deleted_at IS NULL LIMIT 1`,
  );
  const value = rows[0]?.permissions;
  // A raw `db.execute(sql...)` bypasses Drizzle's schema-aware `mode: 'json'` column handling
  // (that only applies to the query builder), so `permissions` — a `text` column on SQLite —
  // comes back as a JSON string there, unlike Postgres' jsonb, which the driver already parses
  // into an object. Parse it by hand only when it actually is a string, so this stays correct on
  // both dialects without branching on `db.dialect` explicitly.
  return (typeof value === 'string' ? JSON.parse(value) : (value ?? {})) as RolePermissions;
}

export interface RoleRow {
  id: string;
  name: string;
}

export async function findRoleByName(db: AnyDb, name: string): Promise<RoleRow | null> {
  const rows = await db.execute(sql`SELECT id, name FROM roles WHERE name = ${name} AND deleted_at IS NULL LIMIT 1`);
  return rows[0] ? (rowToCamelCase(rows[0]) as unknown as RoleRow) : null;
}

/**
 * True once *any* user — active or not — holds a `*:*` permission through their role (i.e.
 * `permissions['*']['*']` exists). Used to decide whether `/api/auth/setup` (root-admin
 * onboarding) is still open. Deliberately ignores `active`: gating on it would let deactivating
 * the sole root admin reopen unauthenticated root creation to anyone who hits the console UI.
 */
export async function hasRootAdmin(db: AnyDb): Promise<boolean> {
  // SQLite's `permissions` column is `text({mode:'json'})`; `json_extract` with a quoted `"*"`
  // path segment reaches the nested key regardless. Postgres' `->` chain does the jsonb
  // equivalent, `?` checking the inner object actually has a `'*'` key (not just that `->'*'`
  // didn't return SQL NULL).
  const query =
    db.dialect === 'sqlite'
      ? sql`SELECT 1
        FROM users u
        JOIN roles r ON r.id = u.role_id AND r.deleted_at IS NULL
        WHERE u.deleted_at IS NULL AND json_extract(r.permissions, '$."*"."*"') IS NOT NULL
        LIMIT 1`
      : sql`SELECT 1
        FROM users u
        JOIN roles r ON r.id = u.role_id AND r.deleted_at IS NULL
        WHERE u.deleted_at IS NULL AND (r.permissions -> '*') ? '*'
        LIMIT 1`;
  const rows = await db.execute(query);
  return rows.length > 0;
}
