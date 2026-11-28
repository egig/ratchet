import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { generate } from '../../codegen/generate.js';
import { resolveDbConfig } from '../../core/config.js';
import { loadConfig, resolveDirs } from '../load-config.js';
import { formatCliError } from '../errors.js';

/**
 * One command a person — or the coding agent working in the project — runs to answer "is what I
 * just changed OK?". Three steps, each reported as PASS/FAIL/SKIP:
 *
 *  1. models — load every model + Domain file and regenerate `.ratchet/` (catches bad field
 *     options, unknown references, misplaced Domains). No migration files are written; that stays
 *     `ratchet generate`'s job.
 *  2. types — `tsc --noEmit` over the project (routes, logic, seed, models).
 *  3. tests — `bun test`, only when the project has any `*.test.ts(x)` file.
 *
 * Exits non-zero when any step fails, so it slots into CI or an agent's "keep going until it
 * passes" loop unchanged.
 */
export async function runCheck(cwd: string): Promise<void> {
  const results: { step: string; status: 'PASS' | 'FAIL' | 'SKIP'; note?: string }[] = [];

  try {
    const config = await loadConfig(cwd);
    const dirs = resolveDirs(cwd, config);
    const { modelCount } = await generate({
      modelsDir: dirs.modelsDir,
      generatedDir: dirs.generatedDir,
      routesDir: dirs.routesDir,
      dialect: resolveDbConfig(config.db).driver,
      plugins: config.plugins,
      configFile: path.join(cwd, 'ratchet.config.ts'),
    });
    results.push({ step: 'models', status: 'PASS', note: `${modelCount} model(s)` });
  } catch (err) {
    console.error(formatCliError(err));
    results.push({ step: 'models', status: 'FAIL' });
  }

  // Types are only meaningful once `.ratchet/` is current, but still worth running after a model
  // failure: a route/logic type error is independent and the agent can fix both in one pass.
  const tscBin = path.join(cwd, 'node_modules', '.bin', 'tsc');
  if (existsSync(path.join(cwd, 'tsconfig.json'))) {
    const code = await run(existsSync(tscBin) ? tscBin : 'bunx', existsSync(tscBin) ? ['-p', 'tsconfig.json', '--noEmit'] : ['tsc', '-p', 'tsconfig.json', '--noEmit'], cwd);
    results.push({ step: 'types', status: code === 0 ? 'PASS' : 'FAIL' });
  } else {
    results.push({ step: 'types', status: 'SKIP', note: 'no tsconfig.json' });
  }

  if (hasTestFiles(cwd)) {
    const code = await run('bun', ['test'], cwd);
    results.push({ step: 'tests', status: code === 0 ? 'PASS' : 'FAIL' });
  } else {
    results.push({ step: 'tests', status: 'SKIP', note: 'no *.test.ts files' });
  }

  console.log('');
  for (const r of results) {
    console.log(`${r.status.padEnd(4)}  ${r.step}${r.note ? `  (${r.note})` : ''}`);
  }
  const failed = results.some((r) => r.status === 'FAIL');
  console.log(failed ? '\ncheck failed — fix the errors above, then run `bun run check` again.' : '\nall checks passed.');
  if (failed) process.exitCode = 1;
}

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const SKIP_DIRS = new Set(['node_modules', '.ratchet', 'dist', '.git']);

function hasTestFiles(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (hasTestFiles(path.join(dir, entry.name))) return true;
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}
