import { mkdir } from 'node:fs/promises';
import { loadConfig, resolveDirs } from '../load-config.js';
import { writeDrizzleKitConfig } from '../drizzle-kit-config.js';
import { runDrizzleKit } from '../run-drizzle-kit.js';

export async function runMigrate(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const { generatedDir, migrationsDir } = resolveDirs(cwd, config);

  await mkdir(migrationsDir, { recursive: true });
  const drizzleConfigFile = await writeDrizzleKitConfig(cwd, generatedDir, migrationsDir, config.db);

  // §7: apply + track the SQL files already emitted by `ratchet generate` — never diff or
  // `push` here.
  await runDrizzleKit(['migrate', '--config', drizzleConfigFile], cwd);
}
