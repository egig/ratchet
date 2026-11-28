import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { generateId, type AnyDb } from '@egig/ratchet/core';
import { connectTestDb, testToolkit as kit } from '@egig/ratchet/testing';
import type { PluginContext } from '@egig/ratchet/plugin';
import { automation } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb("automation plugin's onSetup", () => {
  let client: postgres.Sql;
  let db: AnyDb;

  beforeAll(async () => {
    ({ db, client } = connectTestDb(connectionString!));
    await db.execute(sql`DROP TABLE IF EXISTS agents`);
    await db.execute(sql`
      CREATE TABLE agents (
        id uuid PRIMARY KEY, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz, created_by_id uuid,
        name varchar NOT NULL, description text, system_prompt text NOT NULL, provider_id uuid, model varchar, config jsonb,
        role_id uuid, active boolean NOT NULL DEFAULT true
      )`);
  });
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS agents`);
    await client.end();
  });

  it('seeds the built-in Ratchet agent with no provider, holding the Root role', async () => {
    const plugin = automation();
    const rootRoleId = generateId();
    const ctx = { db, models: {}, domains: {}, env: 'development', plugins: {}, kit } satisfies PluginContext;
    await plugin.onSetup!({ tx: db, rootRoleId, userId: generateId() }, ctx);

    const agents = (await db.execute(sql`SELECT name, provider_id, role_id FROM agents`)) as unknown as Record<string, unknown>[];
    expect(agents).toEqual([{ name: 'Ratchet', provider_id: null, role_id: rootRoleId }]);
  });
});
