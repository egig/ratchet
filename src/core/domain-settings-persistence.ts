import { sql } from 'drizzle-orm';
import type { AnyDb } from './db.js';
import type { DomainDefinition } from './domain.js';
import { buildDomainSettingsSchema } from './validation.js';
import { PipelineError } from './pipeline.js';


const TABLE = 'ratchet_domain_settings';

function defaultsFor(def: DomainDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(def.settingFields ?? {})) {
    if (f.default !== undefined) out[key] = f.default;
  }
  return out;
}

/** Reads one Domain's settings, its declared `field.*` defaults filling in whatever the stored
 * row doesn't cover yet (including "no row at all" — a Domain has settings from the moment its
 * `defineDomain()` declares `settings`, not from whenever someone first saves a value). */
export async function getDomainSettings(db: AnyDb, def: DomainDefinition): Promise<Record<string, unknown>> {
  const rows = await db.execute(
    sql`SELECT ${sql.identifier('values')} FROM ${sql.identifier(TABLE)} WHERE ${sql.identifier('domain')} = ${def.name} LIMIT 1`,
  );
  const row = (rows as unknown as { values: Record<string, unknown> }[])[0];
  return { ...defaultsFor(def), ...(row?.values ?? {}) };
}

/** Validates `input` against `def`'s fields (patch-shaped, ADR 0002) and upserts it, merged over
 * the Domain's current settings, into the shared `ratchet_domain_settings` table. */
export async function updateDomainSettings(
  db: AnyDb,
  def: DomainDefinition,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = buildDomainSettingsSchema(def).safeParse(input);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      if (!(key in fields)) fields[key] = issue.message;
    }
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
  }

  const current = await getDomainSettings(db, def);
  const merged = { ...current, ...(result.data as Record<string, unknown>) };
  const now = new Date().toISOString();

  await db.run(sql`
    INSERT INTO ${sql.identifier(TABLE)} (${sql.identifier('domain')}, ${sql.identifier('values')}, ${sql.identifier('updated_at')})
    VALUES (${def.name}, ${JSON.stringify(merged)}, ${now})
    ON CONFLICT (${sql.identifier('domain')})
    DO UPDATE SET ${sql.identifier('values')} = EXCLUDED.${sql.identifier('values')}, ${sql.identifier('updated_at')} = EXCLUDED.${sql.identifier('updated_at')}
  `);

  return merged;
}
