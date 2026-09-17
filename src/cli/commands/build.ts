import { loadConfig, resolveDirs } from '../load-config.js';
import { buildConsoleClient, buildServerBundle } from '../build-console.js';
import { buildWebClient } from '../build-web.js';

/** Builds the console client (Bun.build + Tailwind, hashed + manifest — see build-console.ts),
 * the web client bundle (hashed + manifest — see build-web.ts; no-op when the site isn't opted
 * into), and a bundled server artifact (edge-runtime groundwork; does not affect `serve`/`dev`). */
export async function runBuild(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const dirs = resolveDirs(cwd, config);

  await buildConsoleClient(dirs, { watch: false, mode: 'prod' });
  await buildWebClient(dirs, { mode: 'prod' });
  await buildServerBundle(cwd, dirs, config.db, config.workflows);
}
