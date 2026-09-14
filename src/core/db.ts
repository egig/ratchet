import type { SQL } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

export type Dialect = 'postgres' | 'sqlite';

type RawPgDb = PgDatabase<any, any, any>;
type RawSqliteDb = LibSQLDatabase<any>;

/**
 * The one DB handle type threaded through every module that runs raw `sql` queries
 * (`core/persistence.ts`, `core/tree.ts`, `core/domain-settings-persistence.ts`, `auth/lookup.ts`,
 * `router/list.ts`, ...). pg-core's `PgDatabase` and sqlite-core's `BaseSQLiteDatabase` (which
 * `LibSQLDatabase` extends) share no common raw-query method: pg-core has `.execute()` returning a
 * bare row array; sqlite-core has `.all()`/`.get()`/`.run()`/`.values()` instead, no `.execute()`
 * at all. Rather than threading a second `dialect` parameter through every one of those functions'
 * signatures, `AnyDb` wraps whichever real drizzle instance `createDb` (`core/db-client.ts`) built
 * behind one normalized `.execute()`/`.run()`/`.transaction()` surface — `dialect` rides along for
 * free as a property on the same handle every call site already carries, and dialect-specific SQL
 * *text* (ILIKE vs LIKE, jsonb `@>` vs `json_each`, ...) branches on `db.dialect` at the handful of
 * call sites that actually need it (see `core/sql-dialect.ts`).
 */
export interface AnyDb {
  readonly dialect: Dialect;
  /** Runs a raw query and returns its rows as plain objects — the read/RETURNING path. */
  execute(query: SQL): Promise<Record<string, unknown>[]>;
  /** Runs a raw query for its side effect only (no rows needed back). */
  run(query: SQL): Promise<void>;
  transaction<T>(fn: (tx: AnyDb) => Promise<T>): Promise<T>;
}

export function wrapDb(raw: RawPgDb | RawSqliteDb, dialect: Dialect): AnyDb {
  if (dialect === 'sqlite') {
    const db = raw as RawSqliteDb;
    return {
      dialect,
      execute: async (query) => (await db.all(query)) as Record<string, unknown>[],
      run: async (query) => {
        await db.run(query);
      },
      transaction: (fn) => db.transaction((tx) => fn(wrapDb(tx as unknown as RawSqliteDb, dialect))),
    };
  }
  const db = raw as RawPgDb;
  return {
    dialect,
    execute: async (query) => (await db.execute(query)) as unknown as Record<string, unknown>[],
    run: async (query) => {
      await db.execute(query);
    },
    transaction: (fn) => db.transaction((tx) => fn(wrapDb(tx as unknown as RawPgDb, dialect))),
  };
}
