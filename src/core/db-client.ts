import { resolveDbConfig, type DbConfig } from './config.js';
import { wrapDb, type AnyDb } from './db.js';

/**
 * Builds the one `AnyDb` handle every entry point (`ratchet serve`, the built `dist/server.js`,
 * tests) uses, dispatching on `config.db.driver`. Dynamic `import()`s so a Postgres-only
 * deployment never bundles `@libsql/client` and vice versa — matters for `ratchet build`'s Node
 * bundle size and for edge targets that only need one driver.
 */
export async function createDb(dbConfig: DbConfig): Promise<AnyDb> {
  const resolved = resolveDbConfig(dbConfig);
  if (resolved.driver === 'sqlite') {
    const { drizzle } = await import('drizzle-orm/libsql');
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: resolved.url, authToken: resolved.authToken });
    return wrapDb(drizzle(client), 'sqlite');
  }
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgres = (await import('postgres')).default;
  const client = postgres(resolved.connectionString);
  return wrapDb(drizzle(client), 'postgres');
}
