import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import type { AnyDb } from '../src/core/db.js';
import { connectTestDb } from './helpers/db.js';
import { sql } from 'drizzle-orm';
import { FileStorage } from '@flystorage/file-storage';
import { InMemoryStorageAdapter } from '@flystorage/in-memory';
import { defineDomain, field } from '../src/core/index.js';
import { generateId } from '../src/core/id.js';
import { createConsoleRouter } from '../src/console/router.js';
import { createNodeFsAssetSource } from '../src/console/node-assets.js';
import { createSiteAssetsRouter } from '../src/router/site-assets.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

// A `public: true` file field alongside a non-public one — exercises `field.file({ public })`
// (core/field.ts) and `deriveDomainSettingsFileFields` (core/serialize.ts) for both cases.
const TestSiteDomain = defineDomain('testsite', {
  settings: {
    publicFile: field.file({ public: true }),
    privateFile: field.file(),
  },
});

function upload(app: ReturnType<typeof createConsoleRouter>, field_: string, token: string, bytes: Uint8Array, filename = 'x.png') {
  const body = new FormData();
  body.append('file', new File([bytes as BlobPart], filename, { type: 'image/png' }));
  return app.request(`/meta/domains/testsite/settings/${field_}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

describeIfDb('Domain Settings public file fields (against a live Postgres)', () => {
  let client: postgres.Sql;
  let db: AnyDb;
  let storage: FileStorage;
  let consoleApp: ReturnType<typeof createConsoleRouter>;
  let siteAssetsApp: ReturnType<typeof createSiteAssetsRouter>;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ratchet_domain_settings (
        domain varchar PRIMARY KEY,
        values jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL
      )
    `);
    // minimal schema — just enough for `resolveSessionUser` (src/auth/pipeline.ts) to resolve a
    // Bearer token; this suite never goes through the real `/register`/`/login` flow, it inserts
    // a session directly (auth.test.ts's own suite already covers that flow end to end).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        email varchar NOT NULL, password_hash varchar NOT NULL, role_id uuid, active boolean NOT NULL DEFAULT true
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        user_id uuid NOT NULL, token varchar NOT NULL, expires_at timestamptz NOT NULL
      )`);

    storage = new FileStorage(new InMemoryStorageAdapter());
    consoleApp = createConsoleRouter(createNodeFsAssetSource('.ratchet-test-site-assets'), {}, db, '/console', { testsite: TestSiteDomain }, storage);
    siteAssetsApp = createSiteAssetsRouter(db, storage, { testsite: TestSiteDomain });
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE ratchet_domain_settings, sessions, users`);
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ratchet_domain_settings`);
    await db.execute(sql`DROP TABLE IF EXISTS sessions`);
    await db.execute(sql`DROP TABLE IF EXISTS users`);
    await client.end();
  });

  async function makeSessionToken(): Promise<string> {
    const userId = generateId();
    const token = generateId();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await db.execute(
      sql`INSERT INTO users (id, created_at, updated_at, email, password_hash, active) VALUES (${userId}, ${now}, ${now}, 'u@example.com', 'x', true)`,
    );
    await db.execute(
      sql`INSERT INTO sessions (id, created_at, updated_at, user_id, token, expires_at) VALUES (${generateId()}, ${now}, ${now}, ${userId}, ${token}, ${expiresAt})`,
    );
    return token;
  }

  describe('console/router.ts POST /meta/domains/:name/settings/:field/upload', () => {
    it('requires auth', async () => {
      const res = await upload(consoleApp, 'publicFile', 'not-a-real-token', new Uint8Array([1, 2, 3]));
      expect(res.status).toBe(401);
    });

    it('401s with no Authorization header at all', async () => {
      const body = new FormData();
      body.append('file', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
      const res = await consoleApp.request('/meta/domains/testsite/settings/publicFile/upload', { method: 'POST', body });
      expect(res.status).toBe(401);
    });

    it('404s for a field that is not a file setting', async () => {
      const token = await makeSessionToken();
      const res = await consoleApp.request('/meta/domains/testsite/settings/nope/upload', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: (() => {
          const f = new FormData();
          f.append('file', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
          return f;
        })(),
      });
      expect(res.status).toBe(404);
    });

    it('stores the blob and returns a StoredFile reference; PATCH + GET settings then shape it into { url } for a public field, with the raw key never leaked', async () => {
      const token = await makeSessionToken();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const uploadRes = await upload(consoleApp, 'publicFile', token, bytes);
      expect(uploadRes.status).toBe(201);
      const stored = ((await uploadRes.json()) as { data: { key: string; filename: string; mimeType: string; size: number } }).data;
      expect(stored.key).toStartWith('domain-settings/testsite/publicFile/');
      expect(stored.filename).toBe('x.png');

      const patchRes = await consoleApp.request('/meta/domains/testsite/settings', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ publicFile: stored }),
      });
      expect(patchRes.status).toBe(200);
      const patched = ((await patchRes.json()) as { data: Record<string, unknown> }).data;
      const patchedFile = patched.publicFile as { url?: string; key?: string; filename: string };
      expect(patchedFile.key).toBeUndefined();
      expect(patchedFile.url).toBe(`/_site-assets/testsite/publicFile/${stored.key.split('/').pop()}`);
      expect(patchedFile.filename).toBe('x.png');

      const getRes = await consoleApp.request('/meta/domains/testsite/settings', { headers: { authorization: `Bearer ${token}` } });
      const got = ((await getRes.json()) as { data: Record<string, unknown> }).data;
      expect((got.publicFile as { url?: string }).url).toBe(patchedFile.url);
    });

    it('a non-public field is stripped of its raw key but never gets a url', async () => {
      const token = await makeSessionToken();
      const uploadRes = await upload(consoleApp, 'privateFile', token, new Uint8Array([1, 2, 3]));
      const stored = ((await uploadRes.json()) as { data: { key: string } }).data;
      await consoleApp.request('/meta/domains/testsite/settings', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ privateFile: stored }),
      });

      const getRes = await consoleApp.request('/meta/domains/testsite/settings', { headers: { authorization: `Bearer ${token}` } });
      const got = ((await getRes.json()) as { data: Record<string, unknown> }).data;
      const privateFile = got.privateFile as { url?: string; key?: string };
      expect(privateFile.key).toBeUndefined();
      expect(privateFile.url).toBeUndefined();
    });
  });

  describe('router/site-assets.ts GET /:domain/:field/:token (no auth)', () => {
    it('streams the current public file back with a long-lived immutable cache header, ignoring the token', async () => {
      const token = await makeSessionToken();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
      const uploadRes = await upload(consoleApp, 'publicFile', token, bytes, 'logo.png');
      const stored = ((await uploadRes.json()) as { data: { key: string } }).data;
      await consoleApp.request('/meta/domains/testsite/settings', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ publicFile: stored }),
      });

      // the real token, and a bogus one — both serve the current value, no session needed either way.
      for (const t of [stored.key.split('/').pop(), 'whatever']) {
        const res = await siteAssetsApp.request(`/testsite/publicFile/${t}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      }
    });

    it('404s for an unknown domain, an unknown field, a non-public field, and a public field with nothing uploaded yet', async () => {
      expect((await siteAssetsApp.request('/nope/publicFile/x')).status).toBe(404);
      expect((await siteAssetsApp.request('/testsite/nope/x')).status).toBe(404);
      expect((await siteAssetsApp.request('/testsite/privateFile/x')).status).toBe(404);
      expect((await siteAssetsApp.request('/testsite/publicFile/x')).status).toBe(404);
    });

  });
});
