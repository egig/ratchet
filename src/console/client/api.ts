import type { ConsoleModelMeta } from '../serialize-model.js';
import type { ConsoleDomainMeta } from '../serialize-domain.js';
import type { FilterNode } from './FilterBar.js';

// '/' (root mount) needs an empty prefix, not a literal '/', so `${MOUNT_PREFIX}/meta/models`
// doesn't come out as '//meta/models'.
const MOUNT_PREFIX = __CONSOLE_PATH__ === '/' ? '' : __CONSOLE_PATH__;

export interface ApiErrorBody {
  error: { code: string; message?: string; fields?: Record<string, string> };
}

/** Thrown by every helper below on a non-2xx response — carries the same `{ code, fields }`
 * shape `toErrorResponse` (src/router/errors.ts) puts on the wire, so a form can map
 * `err.fields` straight onto its inputs. */
export class ApiRequestError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message ?? body.error.code);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.error.code;
    this.fields = body.error.fields;
  }
}

/** JSON request against the app's own API — unwraps `{ data }`, throws `ApiRequestError` on a
 * non-2xx. Exported (as `apiRequest` from `@egig/ratchet/console/client`) for plugin console code. */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // no/invalid JSON body — fall through, handled below per status
  }

  if (!res.ok) {
    const errorBody = (body as Partial<ApiErrorBody> | null)?.error
      ? (body as ApiErrorBody)
      : { error: { code: res.status === 401 ? 'UNAUTHENTICATED' : 'UNKNOWN_ERROR' } };
    throw new ApiRequestError(res.status, errorBody);
  }

  return (body as { data: T }).data;
}

/** Mirrors `ratchet/auth`'s `ActionGrant`/`RolePermissions` (src/auth/lookup.ts) — duplicated
 * rather than imported so this browser bundle never pulls in that module's server-only
 * dependencies (drizzle/db types). `resource -> action -> grant`; either key may be `'*'`. */
interface ClientActionGrant {
  fields?: '*' | string[];
  scope?: 'own' | 'any';
}
type ClientRolePermissions = Record<string, Record<string, ClientActionGrant>>;

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  roleId: string | null;
  active: boolean;
  permissions: ClientRolePermissions;
}

export function setupStatus(): Promise<{ required: boolean }> {
  return request('/api/auth/setup');
}

export interface SetupInput {
  email: string;
  password: string;
}

export function setup(input: SetupInput): Promise<{ user: AuthUser; token: string }> {
  return request('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) });
}

/** better-auth's own endpoints (`/api/auth/sign-in/email`, ...) answer errors as a flat
 * `{ code, message }` and successes as a bare object — not Ratchet's `{ error }`/`{ data }`
 * envelopes — so they get their own helper, normalizing failures into the same `ApiRequestError`. */
async function authRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // empty body
  }
  if (!res.ok) {
    const err = (json ?? {}) as { code?: string; message?: string };
    throw new ApiRequestError(res.status, { error: { code: err.code ?? 'UNKNOWN_ERROR', message: err.message } });
  }
  return json as T;
}

export function login(email: string, password: string): Promise<{ token: string }> {
  return authRequest('/sign-in/email', { email, password });
}

export function logout(): Promise<{ success: boolean }> {
  return authRequest('/sign-out', {});
}

export function me(): Promise<AuthUser> {
  return request('/api/auth/me');
}

export interface ProfileInput {
  email?: string;
  /** required by better-auth to change the password */
  currentPassword?: string;
  newPassword?: string;
}

/** Self-service profile edit through better-auth (`/change-email`, `/change-password`), then a
 * fresh `me()`. Privileged fields (`roleId`/`active`) aren't writable here at all. */
export async function updateProfile(input: ProfileInput): Promise<AuthUser> {
  if (input.email) await authRequest('/change-email', { newEmail: input.email });
  if (input.newPassword) {
    await authRequest('/change-password', {
      currentPassword: input.currentPassword ?? '',
      newPassword: input.newPassword,
      revokeOtherSessions: true,
    });
  }
  return me();
}

export function listModels(): Promise<ConsoleModelMeta[]> {
  return request(`${MOUNT_PREFIX}/meta/models`);
}

export function listDomains(): Promise<ConsoleDomainMeta[]> {
  return request(`${MOUNT_PREFIX}/meta/domains`);
}

export function getDomainSettings(domain: string): Promise<Record<string, unknown>> {
  return request(`${MOUNT_PREFIX}/meta/domains/${encodeURIComponent(domain)}/settings`);
}

export function updateDomainSettings(domain: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(`${MOUNT_PREFIX}/meta/domains/${encodeURIComponent(domain)}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export interface OffsetPage {
  mode: 'offset';
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export async function listRows(
  model: string,
  opts: {
    limit: number;
    offset: number;
    include?: string[];
    /** the same shape `router/query.ts`'s `FilterNode[]` parses, sent as `?filter=<json>` (Q:
     * WorkspaceView's saved `filters` round-trip straight through here). */
    filters?: FilterNode[];
    /** comma-separated priority list of `field` / `-field` (descending) keys, matching
     * `router/query.ts`'s `?sort=` convention — e.g. `'status,-createdAt'`. */
    sort?: string;
  },
): Promise<OffsetPage> {
  const params = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
  if (opts.include?.length) params.set('include', opts.include.join(','));
  if (opts.filters?.length) params.set('filter', JSON.stringify(opts.filters));
  if (opts.sort) params.set('sort', opts.sort);
  const res = await fetch(`/api/${encodeURIComponent(model)}?${params.toString()}`, {
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { data: Record<string, unknown>[]; meta: Omit<OffsetPage, 'mode' | 'rows'> };
  if (!res.ok) {
    const errBody = body as unknown as ApiErrorBody;
    throw new ApiRequestError(res.status, errBody);
  }
  return { mode: 'offset', rows: body.data, ...body.meta };
}

export function getRow(model: string, id: string, opts: { include?: string[] } = {}): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  if (opts.include?.length) params.set('include', opts.include.join(','));
  const qs = params.toString();
  return request(`/api/${encodeURIComponent(model)}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
}

export function createRow(model: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(`/api/${encodeURIComponent(model)}`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateRow(model: string, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(`/api/${encodeURIComponent(model)}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function removeRow(model: string, id: string): Promise<Record<string, unknown>> {
  return request(`/api/${encodeURIComponent(model)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** `POST /api/:model/:id/:operation` — calls a custom operation (core/model.ts's
 * `CustomOperationDefinition`, e.g. `lock`/`unlock`); `params` is omitted entirely for a
 * param-less trigger. Returns the same shape `updateRow` does: the full updated resource, or
 * `null` for an operation that didn't persist a write. */
export function callOperation(
  model: string,
  id: string,
  operation: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return request(`/api/${encodeURIComponent(model)}/${encodeURIComponent(id)}/${encodeURIComponent(operation)}`, {
    method: 'POST',
    body: params ? JSON.stringify(params) : undefined,
  });
}

export interface UploadedFile {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
}

async function uploadTo(url: string, file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch(url, { method: 'POST', body });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // no/invalid JSON body — fall through, handled below per status
  }
  if (!res.ok) {
    const errorBody = (json as Partial<ApiErrorBody> | null)?.error ? (json as ApiErrorBody) : { error: { code: 'UNKNOWN_ERROR' } };
    throw new ApiRequestError(res.status, errorBody);
  }
  return (json as { data: UploadedFile }).data;
}

/** `POST /api/:model/:field/upload` (Q3's two-step upload) — the caller sends the returned
 * `UploadedFile` as the field's own create/update value. Bypasses `request()`: a multipart body
 * must not carry a manually-set `content-type` (the browser sets the boundary itself). */
export function uploadFile(model: string, field: string, file: File): Promise<UploadedFile> {
  return uploadTo(`/api/${encodeURIComponent(model)}/${encodeURIComponent(field)}/upload`, file);
}

/** `POST {MOUNT_PREFIX}/meta/domains/:domain/settings/:field/upload` — `uploadFile`'s Domain
 * Settings counterpart (`console/router.ts`); same two-step flow, the returned `UploadedFile` is
 * submitted as the field's value on the following `updateDomainSettings`. Console-prefixed
 * (`MOUNT_PREFIX`), unlike `uploadFile`, because it lives on the console router, not `/api`. */
export function uploadDomainSettingsFile(domain: string, field: string, file: File): Promise<UploadedFile> {
  return uploadTo(`${MOUNT_PREFIX}/meta/domains/${encodeURIComponent(domain)}/settings/${encodeURIComponent(field)}/upload`, file);
}

/** Most-specific-wins lookup, mirroring `ratchet/auth`'s `lookupActionGrant` (src/auth/pipeline.ts) —
 * a specific resource/action key always shadows a `'*'` sibling rather than merging with it. */
export function hasPermission(permissions: AuthUser['permissions'], resource: string, action: string): boolean {
  const resourceNode = permissions[resource] ?? permissions['*'];
  return resourceNode !== undefined && (resourceNode[action] ?? resourceNode['*']) !== undefined;
}
