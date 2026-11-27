import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '../../core/db-client.js';
import { createSeedContext, type SeedFn } from '../../core/seed.js';
import { loadConfig } from '../load-config.js';

export const SEED_FILE = 'seed.ts';

/**
 * Runs the project's `seed.ts` (default export: `defineSeed(async ({ insert, isEmpty }) => ...)`)
 * against the configured database. A missing `seed.ts` is not an error — seeding is opt-in. The
 * seed itself owns idempotency (`isEmpty` guards), because `ratchet dev` re-runs it after every
 * schema sync so a freshly added model's sample rows show up without a manual step.
 */
export async function runSeed(cwd: string): Promise<void> {
  const seedPath = path.join(cwd, SEED_FILE);
  if (!existsSync(seedPath)) {
    console.log(`no ${SEED_FILE} — nothing to seed`);
    return;
  }
  const config = await loadConfig(cwd);
  const mod = (await import(pathToFileURL(seedPath).href)) as { default?: SeedFn };
  if (typeof mod.default !== 'function') {
    throw new Error(`${SEED_FILE} must have a default export — use export default defineSeed(async ({ insert, isEmpty }) => { ... })`);
  }
  const db = await createDb(config.db);
  await mod.default(createSeedContext(db));
  console.log(`ran ${SEED_FILE}`);
}
