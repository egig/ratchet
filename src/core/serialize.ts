import type { ModelDefinition } from './model.js';
import type { DomainDefinition } from './domain.js';

const AUTO_TIMESTAMP_KEYS = ['createdAt', 'updatedAt', 'deletedAt'];

function toIso(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return value;
}

/**
 * Raw `db.execute(sql...)` rows come back with whatever text/Date representation the driver
 * chose for timestamptz (postgres.js returns Postgres's native `2024-01-01 00:00:00+00` text
 * here, not ISO 8601, since this bypasses Drizzle's typed column mapping — see persistence.ts).
 * Every response — create/update/remove via `persist`, and list/get via the router — normalizes
 * through this so API responses are always ISO 8601, never a driver-specific format.
 */
export function normalizeTimestamps(model: ModelDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const key of AUTO_TIMESTAMP_KEYS) {
    if (key in out) out[key] = toIso(out[key]);
  }
  for (const [key, f] of Object.entries(model.fields)) {
    if (f.kind === 'datetime' && key in out) out[key] = toIso(out[key]);
  }
  return out;
}

/**
 * Raw `db.execute(sql...)` rows return `json`/`file` columns as whatever the driver's native
 * value is: postgres-js already deserializes `jsonb` into objects at the protocol level, but
 * sqlite's `text(mode: 'json')` round-trip is a Drizzle query-builder feature this bypassed path
 * doesn't get — `toDriverValue` (persistence.ts) has to `JSON.stringify` these columns by hand on
 * the way in for the same reason, so sqlite hands them back as JSON-encoded strings on the way
 * out. Parse only when still a string so both dialects end up with the same parsed shape; must
 * run before `deriveFileFields`, which expects an already-parsed object.
 */
export function normalizeJsonFields(model: ModelDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [key, f] of Object.entries(model.fields)) {
    if ((f.kind === 'json' || f.kind === 'file') && typeof out[key] === 'string') {
      out[key] = JSON.parse(out[key] as string);
    }
  }
  return out;
}

/** Strips every `field.*({ sensitive: true })` column (e.g. a password hash) from a row before
 * it can reach an HTTP response — applied at every router response boundary, never in persistence. */
export function redactSensitiveFields(model: ModelDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [key, f] of Object.entries(model.fields)) {
    if (f.sensitive) delete out[key];
  }
  return out;
}

/** A `file` field's column stores `{ key, filename, mimeType, size }` (`StoredFile`, see
 * `core/storage.ts`) — `key` addresses the blob in the storage adapter and must never reach a
 * client (Q12): it would let a caller bypass the gated read route entirely if the adapter or
 * bucket isn't itself locked down. Every row that crosses into an HTTP response is rewritten
 * here, replacing `key` with a `url` pointing at the gated per-field read route
 * (`GET /api/:model/:id/:field`, `router/create-router.ts`) — applied alongside
 * `redactSensitiveFields` at every response boundary. `row.id` must already be set (auto-assigned
 * on insert, always present by the time a row is serialized). */
export function deriveFileFields(model: ModelDefinition, row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [key, f] of Object.entries(model.fields)) {
    if (f.kind !== 'file') continue;
    const value = out[key];
    if (value === null || value === undefined || typeof value !== 'object') continue;
    const { filename, mimeType, size } = value as { filename: unknown; mimeType: unknown; size: unknown };
    out[key] = { url: `/api/${model.name}/${String(out.id)}/${key}`, filename, mimeType, size };
  }
  return out;
}

/** The public, unauthenticated URL a `field.file({ public: true })` Domain Settings value is
 * served at (`router/site-assets.ts`'s `GET /_site-assets/:domain/:field/:token`) — mirrors
 * `deriveFileFields`'s `/api/:model/:id/:field` convention, but keyed by domain+field (Domain
 * Settings has no row `id`, just one value per Domain) instead of a row. `token` is only the
 * trailing, opaque id segment of the stored key (`domain-settings/${domain}/${field}/${id}`, see
 * `console/router.ts`'s upload route) — never the full key, same "don't leak the raw storage key"
 * reasoning as `deriveFileFields`. The route itself ignores `token` for the actual lookup (it
 * always serves whichever value is currently stored); its only job is to give the URL a distinct
 * identity per upload, so a long-lived `Cache-Control: immutable` is safe — replacing the file
 * changes the URL, so a stale cached response is simply never requested again. */
export function siteAssetUrl(domain: string, field: string, storedKey: string): string {
  const token = storedKey.split('/').pop();
  return `/_site-assets/${domain}/${field}/${token}`;
}

/** `deriveFileFields`'s counterpart for Domain Settings (ADR 0002): replaces each `kind: 'file'`
 * setting's raw `{ key, filename, mimeType, size }` with `{ url, filename, mimeType, size }` when
 * the field is `public: true` (see `siteAssetUrl`) — `key` is stripped either way, public or not,
 * same "never let the raw storage key reach a client" rule `deriveFileFields` follows. A
 * non-public `file` setting has no read route yet (nothing consumes it publicly today), so it's
 * left as `{ filename, mimeType, size }` with no `url` — not fetchable, but not leaking its key
 * either. Used by `console/router.ts`'s `/meta/domains/:name/settings` GET/PATCH responses. */
export function deriveDomainSettingsFileFields(def: DomainDefinition, values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  for (const [key, f] of Object.entries(def.settingFields ?? {})) {
    if (f.kind !== 'file') continue;
    const value = out[key];
    if (value === null || value === undefined || typeof value !== 'object') continue;
    const { key: storedKey, filename, mimeType, size } = value as { key: string; filename: unknown; mimeType: unknown; size: unknown };
    out[key] = { ...(f.public ? { url: siteAssetUrl(def.name, key, storedKey) } : {}), filename, mimeType, size };
  }
  return out;
}
