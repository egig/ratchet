import { readdirSync, statSync, chmodSync, copyFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIRS = ['core', 'cli', 'codegen', 'router', 'server', 'auth', 'automation', 'workflows', 'workspace', 'web', 'console'];

// `ratchet init`'s scaffold source — a verbatim project tree, not framework code. Kept out of the
// build's entrypoint walk (its .ts/.tsx must not be transformed) and copied wholesale into dist/.
const STUBS_SRC = path.join(ROOT, 'src', 'cli', 'stubs');

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (full === STUBS_SRC) continue;
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const entrypoints = SRC_DIRS.flatMap((dir) => walk(path.join(ROOT, 'src', dir), []));

  // Unbundled — one output file per source file, matching today's dist/ shape (Q2). `external:
  // ['*']` is the key: it stops Bun.build from resolving *any* specifier (bare package or
  // relative sibling), so every import statement is emitted byte-for-byte as written in source —
  // the same behavior esbuild's `bundle: false` + `packages: 'external'` gave us.
  const result = await Bun.build({
    entrypoints,
    outdir: path.join(ROOT, 'dist'),
    root: path.join(ROOT, 'src'),
    target: 'node',
    format: 'esm',
    external: ['*'],
    sourcemap: 'linked',
    define: {
      // The automatic JSX transform (src/console/client/*.tsx) picks the dev-only
      // `react/jsx-dev-runtime` unless it sees `process.env.NODE_ENV` resolve to `'production'` —
      // setting the actual env var doesn't reach it (the check runs against a snapshot taken
      // before this script's own top-level code runs), so `define` is the reliable lever.
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Bun.build failed');
  }

  // Declarations only — tsc still owns type-checking and .d.ts emission (see plan Context).
  const tsc = spawnSync('bunx', ['tsc', '-p', 'tsconfig.build.json', '--emitDeclarationOnly'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (tsc.status !== 0) {
    throw new Error(`tsc --emitDeclarationOnly exited with code ${tsc.status}`);
  }

  chmodSync(path.join(ROOT, 'dist', 'cli', 'bin.js'), 0o755);

  // The walk above only picks up .ts/.tsx — the console client's Tailwind source is plain CSS, so
  // `buildConsoleClient` (src/cli/build-console.ts) can find it alongside the compiled main.js in
  // a published dist/, the same way it finds main.tsx/main.js when running from source.
  copyFileSync(
    path.join(ROOT, 'src', 'console', 'client', 'styles.css'),
    path.join(ROOT, 'dist', 'console', 'client', 'styles.css'),
  );

  // The `ratchet init` scaffold — copied verbatim so init.ts resolves `../stubs` from
  // dist/cli/commands/ the same way it does from src/cli/commands/.
  cpSync(STUBS_SRC, path.join(ROOT, 'dist', 'cli', 'stubs'), { recursive: true });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
