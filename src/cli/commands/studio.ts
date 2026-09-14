import { loadConfig, resolveDirs } from '../load-config.js';
import { writeDrizzleKitConfig } from '../drizzle-kit-config.js';
import { runDrizzleKit } from '../run-drizzle-kit.js';

export async function runStudio(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const { generatedDir, migrationsDir } = resolveDirs(cwd, config);
  const drizzleConfigFile = await writeDrizzleKitConfig(cwd, generatedDir, migrationsDir, config.db);

  // §6: proxies to `drizzle-kit studio` — no reimplementation of a DB browser.
  await runDrizzleKit(['studio', '--config', drizzleConfigFile], cwd);
}
