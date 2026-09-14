#!/usr/bin/env bun
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runGenerate } from './commands/generate.js';
import { runMigrate } from './commands/migrate.js';
import { runStudio } from './commands/studio.js';
import { runDev } from './commands/dev.js';
import { runServe } from './commands/serve.js';
import { runBuild } from './commands/build.js';
import { runCreateAdmin } from './commands/create-admin.js';

// Every command below resolves paths off `process.cwd()` — Bun automatically loads `.env` (and
// `.env.local`, etc.) from that same directory (e.g. `DATABASE_URL`) at startup, before any
// command runs. Silently a no-op for projects with no `.env`.

const program = new Command();
program.name('ratchet').description('Model -> Postgres schema, codegen, and composable pipelines.');

program
  .command('init')
  .description('Scaffold a new project: package.json, tsconfig.json, ratchet.config.ts, and an example model')
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command('generate')
  .description('Regenerate the schema, Zod validators, and model registry, then run drizzle-kit generate to emit SQL migration files')
  .action(async () => {
    await runGenerate(process.cwd());
  });

program
  .command('migrate')
  .description('Apply pending SQL migration files with drizzle-kit migrate (run `ratchet generate` first to create them)')
  .action(async () => {
    await runMigrate(process.cwd());
  });

program
  .command('studio')
  .description('Proxy to `drizzle-kit studio`')
  .action(async () => {
    await runStudio(process.cwd());
  });

program
  .command('dev')
  .description('Watch models/**/*.model.ts; on change, regenerate, `drizzle-kit push`, and restart the dev server')
  .action(async () => {
    await runDev(process.cwd());
  });

program
  .command('serve')
  .description('Boot the API server: ratchet.config.ts + the generated registry -> a listening /api/:model router')
  .action(async () => {
    await runServe(process.cwd());
  });

program
  .command('build')
  .description('Build the console client (Bun.build + Tailwind, hashed + manifest) and a bundled server artifact')
  .action(async () => {
    await runBuild(process.cwd());
  });

program
  .command('create-admin')
  .description('Create the root admin user directly against the DB — the production bootstrap path, since /setup is disabled in production')
  .option('--email <email>')
  .option('--password <password>')
  .action(async (opts: { email?: string; password?: string }) => {
    await runCreateAdmin(process.cwd(), opts);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
