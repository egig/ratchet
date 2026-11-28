import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FrameworkConfig } from '../core/config.js';
import { assertValidConsolePath } from '../server/console-path.js';

export async function loadConfig(cwd: string): Promise<FrameworkConfig> {
  const configPath = path.join(cwd, 'ratchet.config.ts');
  const moduleUrl = pathToFileURL(configPath).href;
  const mod = (await import(moduleUrl)) as { default?: FrameworkConfig };
  if (!mod.default) {
    throw new Error(`${configPath} must have a default export — use export default defineConfig({ ... })`);
  }
  return mod.default;
}

/** See `assertValidConsolePath` and `FrameworkConfig.consolePath`. */
function resolveConsolePath(config: FrameworkConfig): string {
  const consolePath = config.consolePath ?? '/console';
  assertValidConsolePath(consolePath);
  return consolePath;
}

export function resolveDirs(cwd: string, config: FrameworkConfig) {
  return {
    modelsDir: path.resolve(cwd, config.modelsDir ?? 'models'),
    generatedDir: path.resolve(cwd, config.generatedDir ?? '.ratchet'),
    migrationsDir: path.resolve(cwd, config.migrationsDir ?? 'migrations'),
    routesDir: path.resolve(cwd, config.routesDir ?? 'routes'),
    publicDir: path.resolve(cwd, config.publicDir ?? 'public'),
    consolePath: resolveConsolePath(config),
    brand: config.brand ?? {},
    /** for the console build's Tailwind inputs (`RatchetPlugin.consoleStyles`) */
    plugins: config.plugins ?? [],
  };
}
