import { createInterface } from 'node:readline/promises';
import { createDb } from '../../core/db-client.js';
import { loadConfig } from '../load-config.js';
import { hasRootAdmin } from '../../auth/lookup.js';
import { provisionRootAdmin } from '../../auth/provisioning.js';

/**
 * Production's bootstrap path for the first root admin — `/api/auth/setup` 404s
 * unconditionally when `env` resolves to `'production'` (see `resolveEnv`, `core/config.ts`),
 * so this provisions the same user directly against the DB instead of over HTTP. Shares
 * `provisionRootAdmin` with `POST /setup` (`src/auth/router.ts`) so the two paths can't drift.
 * Refuses once a root admin already exists — same one-time guard `/setup` had; creating
 * additional admins afterward goes through the authenticated console instead.
 */
export async function runCreateAdmin(cwd: string, opts: { email?: string; password?: string } = {}): Promise<void> {
  const config = await loadConfig(cwd);
  const db = await createDb(config.db);

  if (await hasRootAdmin(db)) {
    console.error('A root admin already exists.');
    process.exit(1);
  }

  let { email, password } = opts;
  if (!email || !password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      email ??= await rl.question('Admin email: ');
      password ??= await rl.question('Admin password: ');
    } finally {
      rl.close();
    }
  }

  await provisionRootAdmin(db, { email, password });
  console.log(`Root admin ${email} created.`);
  // The postgres driver keeps a connection pool alive, which would otherwise hold the process
  // open indefinitely after a one-shot CLI command finishes.
  process.exit(0);
}
