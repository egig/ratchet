import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { AnyDb } from '../../src/core/db.js';
import { wrapDb } from '../../src/core/db.js';

/**
 * Every DB-backed suite in `test/` hand-writes its own fixture tables as raw Postgres DDL
 * (`uuid`, `timestamptz`, `TRUNCATE TABLE`, ...) — that's a per-suite concern this helper
 * deliberately doesn't touch. What *is* identical across all ~10 suites is the postgres-js client
 * construction + `DATABASE_URL`-gated skip, previously duplicated verbatim in each file; this
 * centralizes that part only.
 *
 * SQLite/libsql fixtures need their own DDL per suite (no `uuid`/`timestamptz`/`TRUNCATE` there —
 * see `docs/adr/0004-sqlite-libsql-second-db-driver.md` for the column-type mapping), which is a
 * larger follow-up left deliberately out of this change rather than shipped unverified.
 */
export function testDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

export interface TestDb {
  db: AnyDb;
  client: postgres.Sql;
}

/** Call once in a suite's `beforeAll`, after gating the suite on `testDatabaseUrl()` — see any
 * existing DB-backed suite (e.g. `test/tree.test.ts`) for the `describeIfDb` pattern. */
export function connectTestDb(connectionString: string): TestDb {
  const client = postgres(connectionString);
  const db = wrapDb(drizzle(client), 'postgres');
  return { db, client };
}
