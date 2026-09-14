import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { sql } from 'drizzle-orm';
import { defineDomain, field } from '../src/core/index.js';
import { getDomainSettings, updateDomainSettings } from '../src/core/domain-settings-persistence.js';
import { createConsoleRouter } from '../src/console/router.js';
import { createNodeFsAssetSource } from '../src/console/node-assets.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

const AuthSettings = defineDomain('auth', {
  label: 'Authentication',
  settings: {
    sessionTtlDays: field.integer({ default: 7 }),
    requireMfa: field.boolean({ default: false }),
  },
});

describeIfDb('Domain Settings (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    // mirrors the table schema-gen.ts unconditionally emits (ADR 0002).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ratchet_domain_settings (
        domain varchar PRIMARY KEY,
        values jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ratchet_domain_settings`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ratchet_domain_settings`);
    await client.end();
  });

  describe('core/domain-settings-persistence.ts', () => {
    it('getDomainSettings falls back to field defaults when no row exists yet', async () => {
      const values = await getDomainSettings(db, AuthSettings);
      expect(values).toEqual({ sessionTtlDays: 7, requireMfa: false });
    });

    it('updateDomainSettings validates, merges over current values, and persists', async () => {
      const after1 = await updateDomainSettings(db, AuthSettings, { sessionTtlDays: 30 });
      expect(after1).toEqual({ sessionTtlDays: 30, requireMfa: false });

      const after2 = await updateDomainSettings(db, AuthSettings, { requireMfa: true });
      expect(after2).toEqual({ sessionTtlDays: 30, requireMfa: true });

      expect(await getDomainSettings(db, AuthSettings)).toEqual({ sessionTtlDays: 30, requireMfa: true });
    });

    it('rejects a value of the wrong type with a VALIDATION_ERROR carrying field errors', async () => {
      await expect(updateDomainSettings(db, AuthSettings, { sessionTtlDays: 'not a number' })).rejects.toMatchObject(
        { code: 'VALIDATION_ERROR', status: 400, fields: { sessionTtlDays: expect.any(String) } },
      );
    });
  });

  describe('console/router.ts /meta/domains* (unauthenticated, so every call 401s — the routes exist and are wired correctly if they do)', () => {
    const app = createConsoleRouter(createNodeFsAssetSource('.ratchet-test-domains'), {}, db, '/console', {
      auth: AuthSettings,
    });

    it('GET /meta/domains/:name/settings requires auth', async () => {
      const res = await app.request('/meta/domains/auth/settings');
      expect(res.status).toBe(401);
    });

    it('PATCH /meta/domains/:name/settings requires auth', async () => {
      const res = await app.request('/meta/domains/auth/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionTtlDays: 1 }),
      });
      expect(res.status).toBe(401);
    });
  });
});
