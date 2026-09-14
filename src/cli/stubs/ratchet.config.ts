import { defineConfig } from '@egig/ratchet/core';

export default defineConfig({
  // Zero-setup by default: a local SQLite file, no external database to install or run. Point
  // DATABASE_URL at a Postgres connection string (and switch driver to 'postgres' below) or a
  // remote Turso URL to use something else instead — see the "Database" doc for the switch.
  db: { driver: 'sqlite', url: process.env.DATABASE_URL ?? 'file:./local.db', authToken: process.env.DATABASE_AUTH_TOKEN },
  modelsDir: 'models',
  generatedDir: '.ratchet',
  migrationsDir: 'migrations',
});
