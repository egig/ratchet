import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { generate } from '../../codegen/generate.js';
import { loadConfig, resolveDirs } from '../load-config.js';
import { writeDrizzleKitConfig } from '../drizzle-kit-config.js';
import { runDrizzleKit } from '../run-drizzle-kit.js';
import { buildConsoleClient, type ConsoleClientHandle } from '../build-console.js';
import { buildWebClient } from '../build-web.js';
import { resolveDbConfig, type FrameworkConfig } from '../../core/config.js';
import { runSeed, SEED_FILE } from './seed.js';
import path from 'node:path';

const DEBOUNCE_MS = 200;

/**
 * One schema sync: regenerate `.ratchet/`, `drizzle-kit push`, rebuild the web bundle, then run
 * `seed.ts` (if any). `runDev` never calls this in-process — it spawns `ratchet dev-sync` per change
 * instead, because Bun caches ES modules by URL: re-`import()`ing an edited `*.model.ts` inside the
 * long-lived `dev` process returns the *old* module, so an in-process regenerate would silently
 * emit a schema for the previous model shape. A fresh child process always reads the current files.
 */
export async function runDevSync(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const dirs = resolveDirs(cwd, config);
  await generateAndPush(cwd, dirs, config);
  await runSeed(cwd);
}

async function generateAndPush(cwd: string, dirs: ReturnType<typeof resolveDirs>, config: FrameworkConfig): Promise<void> {
  await generate({
    modelsDir: dirs.modelsDir,
    generatedDir: dirs.generatedDir,
    routesDir: dirs.routesDir,
    dialect: resolveDbConfig(config.db).driver,
    plugins: config.plugins,
    configFile: path.join(cwd, 'ratchet.config.ts'),
  });
  const drizzleConfigFile = await writeDrizzleKitConfig(cwd, dirs.generatedDir, dirs.migrationsDir, config.db);
  // §7: `dev` is the one place `push` is used — immediate schema sync, no migration files.
  // `--force` auto-approves data-loss statements; acceptable because this only ever targets a
  // local dev database, never staging/prod (which always goes through generate+migrate instead).
  await runDrizzleKit(['push', '--config', drizzleConfigFile, '--force'], cwd);
  // rebuild the web client bundle after each regenerate (the route module set may have changed).
  // Bun.build has no incremental watch API, so this is a one-shot rebuild — cheap for the small
  // trees this targets; a proper dev watch loop is phase 6.
  await buildWebClient(dirs, { mode: 'dev' });
}

/** §6: watch model files; on change, regenerate + push + restart the dev server. */
export async function runDev(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const dirs = resolveDirs(cwd, config);

  let child: ChildProcess | null = null;
  let restarting = false;
  let pendingRestart = false;
  let shuttingDown = false;

  // Re-invoke this same CLI entry point (whatever launched `dev` — the .ts source under bun, or
  // the built dist/cli/bin.js) with `serve` instead of `dev`, via `bun` so both cases work
  // uniformly (Bun transpiles .ts natively, no separate loader needed). A child process, not an
  // in-process restart, so a bad model change crashes the spawned server without taking `dev`'s
  // watch loop down with it.
  const cliEntry = process.argv[1]!;

  /** Runs `ratchet dev-sync` in a fresh process (see `runDevSync` for why) — resolves `true` on
   * success. Its stdout/stderr (including drizzle-kit's and the error hint) go straight through. */
  function sync(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('bun', [cliEntry, 'dev-sync'], { cwd, stdio: 'inherit' });
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    });
  }

  function startServer(): void {
    child = spawn('bun', [cliEntry, 'serve'], { cwd, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      // Ctrl-C reaches the child directly through the shared terminal process group, so it exits
      // with SIGINT (code 130) before `shutdown` gets a turn — that, a signal kill, and our own
      // restart/shutdown teardown are all deliberate, not a crash worth reporting.
      const deliberate = restarting || shuttingDown || signal !== null || code === 130 || code === 143;
      if (!deliberate && code !== 0) {
        console.error(`[dev] server exited with code ${code}`);
      }
    });
  }

  async function stopServer(): Promise<void> {
    if (!child) return;
    const dying = child;
    child = null;
    // May already be gone — Ctrl-C kills it via the terminal before we get here — in which case
    // `exit` has fired and won't fire again, so waiting on it would hang forever.
    if (dying.exitCode !== null || dying.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      dying.once('exit', () => resolve());
      dying.kill();
    });
  }

  async function restart(reason: string): Promise<void> {
    if (restarting) {
      pendingRestart = true;
      return;
    }
    restarting = true;
    console.log(`[dev] ${reason} — regenerating and pushing schema...`);
    if (!(await sync())) {
      console.error('[dev] sync failed (see the error above) — keeping the previous server running. Save a fix and it retries.');
      restarting = false;
      if (pendingRestart) {
        pendingRestart = false;
        await restart('queued change');
      }
      return;
    }
    await stopServer();
    startServer();
    restarting = false;
    if (pendingRestart) {
      pendingRestart = false;
      await restart('queued change');
    }
  }

  if (!(await sync())) {
    // Nothing to keep running yet on the very first sync — but don't exit either: stay in the
    // watch loop so saving a fix brings the server up, which is what a beginner (or an agent)
    // fixing the reported error expects.
    console.error('[dev] initial sync failed (see the error above) — fix it and save; dev will retry.');
  } else {
    startServer();
  }
  const consoleHandle: ConsoleClientHandle = await buildConsoleClient(dirs, { watch: true, mode: 'dev' });
  console.log(`[dev] watching ${dirs.modelsDir} for changes`);

  let debounceTimer: NodeJS.Timeout | undefined;
  watch(dirs.modelsDir, { recursive: true }, (_event, filename) => {
    if (!filename || !(filename.endsWith('.model.ts') || filename.endsWith('.form.tsx') || filename.endsWith('.input.tsx'))) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void restart(`${filename} changed`), DEBOUNCE_MS);
  });

  // The developer's React Router site — regenerate the route manifests + restart on any change.
  // (The web client bundle rebuild is driven by `buildWebClient`'s own dev watcher — phase 4/6.)
  if (existsSync(dirs.routesDir)) {
    watch(dirs.routesDir, { recursive: true }, (_event, filename) => {
      if (!filename || !/\.(tsx|ts|jsx|js)$/.test(filename)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void restart(`${filename} changed`), DEBOUNCE_MS);
    });
    console.log(`[dev] watching ${dirs.routesDir} for changes`);
  }

  const seedPath = path.join(cwd, SEED_FILE);
  if (existsSync(seedPath)) {
    watch(seedPath, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void restart(`${SEED_FILE} changed`), DEBOUNCE_MS);
    });
  }

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(debounceTimer);
    await stopServer();
    await consoleHandle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // keep the process alive — fs.watch + the child process are the only reasons this doesn't exit.
  await new Promise<void>(() => {});
}
