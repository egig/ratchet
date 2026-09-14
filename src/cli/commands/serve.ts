import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '../../core/db-client.js';
import { createRatchetApp, type RatchetBundle } from '../../server/index.js';
import { createNodeFsAssetSource } from '../../console/node-assets.js';
import { buildStorageAdapter } from '../../core/storage-config.js';
import { loadConfig, resolveDirs } from '../load-config.js';
import { resolveEnv } from '../../core/config.js';
import { webEntrySrc } from '../build-web.js';

/**
 * `ratchet serve` — build the infrastructure (`db`, `storage`, console asset source) from
 * `ratchet.config.ts` + the generated `.ratchet/app.ts` bundle, hand it to `createRatchetApp`
 * (which owns the route-mounting sequence — see `src/server/`), and boot a Bun listener. Apps
 * never hand-write a server entry file.
 */
export async function runServe(cwd: string): Promise<ReturnType<typeof Bun.serve>> {
  const config = await loadConfig(cwd);
  const dirs = resolveDirs(cwd, config);
  const { generatedDir } = dirs;

  const bundleFile = path.join(generatedDir, 'app.ts');
  const { bundle } = (await import(pathToFileURL(bundleFile).href)) as { bundle: RatchetBundle };

  const db = await createDb(config.db);

  // built from `config.storage` (default: local fs, sibling to `<generatedDir>/console`,
  // gitignored the same way `generatedDir` itself is) — see `buildStorageAdapter`.
  const storage = await buildStorageAdapter(config.storage, path.join(generatedDir, 'storage'));

  const app = await createRatchetApp({
    db,
    bundle,
    storage,
    consoleAssets: createNodeFsAssetSource(generatedDir),
    consolePath: dirs.consolePath,
    web: bundle.web
      ? { entrySrc: await webEntrySrc(dirs), publicDir: dirs.publicDir, generatedDir }
      : undefined,
    env: resolveEnv(config),
  });

  const port = Number(process.env.PORT ?? 3000);
  const server = Bun.serve({ fetch: app.fetch, port });
  console.log(`ratchet listening on http://localhost:${server.port}`);
  console.log(`models: ${Object.keys(bundle.models).join(', ')}`);
  return server;
}
