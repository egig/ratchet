import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { generate } from '../../codegen/generate.js';
import { loadConfig, resolveDirs } from '../load-config.js';
import { writeDrizzleKitConfig } from '../drizzle-kit-config.js';
import { runDrizzleKit } from '../run-drizzle-kit.js';
import { resolveDbConfig } from '../../core/config.js';

export async function runGenerate(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const { modelsDir, generatedDir, migrationsDir, routesDir } = resolveDirs(cwd, config);

  const { modelCount, domainCount, formCount, fieldInputCount, routeCount, files } = await generate({
    modelsDir,
    generatedDir,
    routesDir,
    dialect: resolveDbConfig(config.db).driver,
  });

  console.log(
    `generated ${modelCount} model(s), ${domainCount} domain settings, ${formCount} custom console form(s), ${fieldInputCount} custom console field input(s)` +
      `${routeCount > 0 ? `, ${routeCount} web route(s)` : ''} -> ${path.relative(cwd, generatedDir)}/`,
  );
  for (const file of files) {
    console.log(`  ${path.relative(cwd, file)}`);
  }

  // §7: emit reviewable SQL migration files from the fresh schema diff — `ratchet migrate`
  // only applies what lands here.
  await mkdir(migrationsDir, { recursive: true });
  const drizzleConfigFile = await writeDrizzleKitConfig(cwd, generatedDir, migrationsDir, config.db);
  await runDrizzleKit(['generate', '--config', drizzleConfigFile], cwd);
}
