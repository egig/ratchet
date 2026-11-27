import { sql, type SQL } from 'drizzle-orm';
import { createAdapterFactory, type CleanedWhere, type DBAdapter } from 'better-auth/adapters';
import type { BetterAuthOptions } from 'better-auth';
import type { AnyDb } from '../core/db.js';
import { rowToCamelCase, toSnakeCase } from '../core/naming.js';

/**
 * better-auth's storage adapter, written against Ratchet's own `AnyDb` handle rather than
 * better-auth's drizzle adapter. Three reasons (ADR 0005):
 *
 * - `AnyDb` is the one handle every entry point already threads through (`createRatchetApp`, the
 *   Cloudflare/Vercel templates, tests) — the drizzle adapter would also need the raw drizzle
 *   instance plus the generated table objects, which `createRatchetApp` never receives.
 * - better-auth's tables are ordinary Ratchet models (`src/auth/models/`), so they carry the
 *   system columns every model has. Reads here skip soft-deleted rows (`deleted_at IS NULL`), so a
 *   user removed from the console can't sign in; better-auth's own deletes (sessions,
 *   verifications) are hard deletes, which is what it expects.
 * - Ratchet stores datetimes as ISO-8601 strings on both dialects (`supportsDates: false` makes the
 *   factory convert both ways) and booleans natively on Postgres but as 0/1 on SQLite.
 *
 * better-auth names tables and columns in camelCase; Ratchet's are snake_case, so both are converted
 * at this boundary. Table names come from `usePlural` (`user` -> `users`, `twoFactor` ->
 * `two_factors`).
 */
export function ratchetAdapter(db: AnyDb): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  const ident = (name: string) => sql.identifier(toSnakeCase(name));
  // `usePlural` makes better-auth's `twoFactor` model `twoFactors`; Ratchet's table for it is
  // `two_factors` (a `defineModel('two_factors', ...)` the app declares for the plugin).
  const table = (model: string) => sql.identifier(toSnakeCase(model));

  function condition(w: CleanedWhere): SQL {
    const column = ident(w.field);
    const insensitive = w.mode === 'insensitive' && typeof w.value === 'string';
    const lhs = insensitive ? sql`lower(${column})` : sql`${column}`;
    const value = insensitive ? (w.value as string).toLowerCase() : w.value;
    const like = (pattern: string) => sql`${lhs} LIKE ${pattern}`;
    switch (w.operator) {
      case 'eq':
        return value === null ? sql`${column} IS NULL` : sql`${lhs} = ${value}`;
      case 'ne':
        return value === null ? sql`${column} IS NOT NULL` : sql`${lhs} <> ${value}`;
      case 'lt':
        return sql`${lhs} < ${value}`;
      case 'lte':
        return sql`${lhs} <= ${value}`;
      case 'gt':
        return sql`${lhs} > ${value}`;
      case 'gte':
        return sql`${lhs} >= ${value}`;
      case 'in':
      case 'not_in': {
        const list = Array.isArray(value) ? (value as unknown[]) : [value];
        // `IN ()` is a syntax error on both dialects; an empty list matches nothing (or everything).
        if (list.length === 0) return w.operator === 'in' ? sql`1 = 0` : sql`1 = 1`;
        const items = sql.join(
          list.map((v) => sql`${v}`),
          sql`, `,
        );
        return w.operator === 'in' ? sql`${lhs} IN (${items})` : sql`${lhs} NOT IN (${items})`;
      }
      case 'contains':
        return like(`%${String(value)}%`);
      case 'starts_with':
        return like(`${String(value)}%`);
      case 'ends_with':
        return like(`%${String(value)}`);
    }
  }

  /** better-auth's `connector` is per-condition: AND-ed conditions bind as one group, OR-ed ones as
   * another, and the two groups are AND-ed together — the same grouping its drizzle/kysely adapters
   * use. Every query is additionally scoped to live (not soft-deleted) rows. */
  function whereClause(where: CleanedWhere[] | undefined): SQL {
    const live = sql`${sql.identifier('deleted_at')} IS NULL`;
    if (!where || where.length === 0) return sql` WHERE ${live}`;
    const and = where.filter((w) => w.connector !== 'OR').map(condition);
    const or = where.filter((w) => w.connector === 'OR').map(condition);
    const parts = [live, ...and];
    if (or.length > 0) parts.push(sql`(${sql.join(or, sql` OR `)})`);
    return sql` WHERE ${sql.join(parts, sql` AND `)}`;
  }

  function assignments(data: Record<string, unknown>): SQL {
    return sql.join(
      Object.entries(data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => sql`${ident(k)} = ${v}`),
      sql`, `,
    );
  }

  const out = (row: Record<string, unknown> | undefined) => (row ? rowToCamelCase(row) : null);
  const now = () => new Date().toISOString();

  return createAdapterFactory({
    config: {
      adapterId: 'ratchet',
      adapterName: 'Ratchet Adapter',
      usePlural: true,
      supportsDates: false,
      supportsBooleans: db.dialect === 'postgres',
      supportsJSON: false,
      supportsArrays: false,
      // ids come from `advanced.database.generateId` (uuidv7, src/auth/better-auth.ts) — the
      // Postgres `id` columns are `uuid`, which better-auth's default random ids aren't.
      supportsUUIDs: false,
      // Sequential, like better-auth's own drizzle adapter defaults to: an outer transaction would
      // deadlock local SQLite as soon as better-auth issued a statement outside it.
      transaction: false,
    },
    adapter: () => ({
      async create({ model, data }) {
        const row: Record<string, unknown> = { ...data };
        // Ratchet's system columns are NOT NULL; better-auth sets them on its core models, but a
        // plugin model may not.
        row.createdAt ??= now();
        row.updatedAt ??= now();
        const keys = Object.keys(row).filter((k) => row[k] !== undefined);
        const rows = await db.execute(
          sql`INSERT INTO ${table(model)} (${sql.join(keys.map(ident), sql`, `)}) VALUES (${sql.join(
            keys.map((k) => sql`${row[k]}`),
            sql`, `,
          )}) RETURNING *`,
        );
        return out(rows[0]) as never;
      },

      async findOne({ model, where }) {
        const rows = await db.execute(sql`SELECT * FROM ${table(model)}${whereClause(where)} LIMIT 1`);
        return out(rows[0]) as never;
      },

      async findMany({ model, where, limit, offset, sortBy }) {
        const order = sortBy
          ? sql` ORDER BY ${ident(sortBy.field)} ${sortBy.direction === 'desc' ? sql`DESC` : sql`ASC`}`
          : sql``;
        const rows = await db.execute(
          sql`SELECT * FROM ${table(model)}${whereClause(where)}${order} LIMIT ${limit} OFFSET ${offset ?? 0}`,
        );
        return rows.map((r) => rowToCamelCase(r)) as never;
      },

      async count({ model, where }) {
        const rows = await db.execute(sql`SELECT COUNT(*) AS n FROM ${table(model)}${whereClause(where)}`);
        return Number(rows[0]?.n ?? 0);
      },

      async update({ model, where, update }) {
        const data: Record<string, unknown> = { ...(update as Record<string, unknown>) };
        data.updatedAt ??= now();
        // `update` targets one row; resolve it first so a non-unique `where` can't fan out.
        const target = await db.execute(sql`SELECT id FROM ${table(model)}${whereClause(where)} LIMIT 1`);
        if (!target[0]) return null;
        const rows = await db.execute(
          sql`UPDATE ${table(model)} SET ${assignments(data)} WHERE ${sql.identifier('id')} = ${target[0].id} RETURNING *`,
        );
        return out(rows[0]) as never;
      },

      async updateMany({ model, where, update }) {
        const data: Record<string, unknown> = { ...update };
        data.updatedAt ??= now();
        const rows = await db.execute(sql`UPDATE ${table(model)} SET ${assignments(data)}${whereClause(where)} RETURNING id`);
        return rows.length;
      },

      async delete({ model, where }) {
        await db.run(sql`DELETE FROM ${table(model)}${whereClause(where)}`);
      },

      async deleteMany({ model, where }) {
        const rows = await db.execute(sql`DELETE FROM ${table(model)}${whereClause(where)} RETURNING id`);
        return rows.length;
      },
    }),
  });
}
