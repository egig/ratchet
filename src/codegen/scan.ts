import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelDefinition } from '../core/model.js';
import { folderDomainOf } from './domain-path.js';

export interface ScannedModel {
  filePath: string;
  exportName: string;
  model: ModelDefinition;
  /** set for the framework's own built-in models (src/codegen/builtins.ts) — e.g. `'@egig/ratchet/auth'`
   * for User/Role/Session, `'@egig/ratchet/automation'` for Agent/Chat/Message. When set,
   * codegen imports the model from this package specifier instead of a relative filesystem path. */
  builtinPackage?: string;
  /** this model's Domain (ADR 0001), inferred from the top-level `modelsDir` subdirectory its file
   * lives in; undefined for a model declared directly under `modelsDir`. Builtins set this
   * explicitly (see builtins.ts) since they aren't reachable by this scan. */
  domain?: string;
}

function isModelDefinition(value: unknown): value is ModelDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelDefinition).name === 'string' &&
    typeof (value as ModelDefinition).tableName === 'string' &&
    typeof (value as ModelDefinition).fields === 'object' &&
    typeof (value as ModelDefinition).operations === 'object'
  );
}

async function findModelFiles(modelsDir: string): Promise<string[]> {
  const entries = await readdir(modelsDir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.model.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

export function assertNoDuplicateNames(scanned: ScannedModel[]): void {
  const seen = new Map<string, string>();
  for (const { model, filePath } of scanned) {
    const existing = seen.get(model.name);
    if (existing) {
      throw new Error(
        `duplicate model name '${model.name}' declared in both '${existing}' and '${filePath}' — model names must be unique (they double as the table name and REST route segment).`,
      );
    }
    seen.set(model.name, filePath);
  }
}

export function assertReferencesResolve(scanned: ScannedModel[]): void {
  const names = new Set(scanned.map((s) => s.model.name));
  for (const { model } of scanned) {
    for (const [key, f] of Object.entries(model.fields)) {
      if ((f.kind === 'reference' || f.kind === 'manyToMany' || f.kind === 'tree' || f.kind === 'referenceToMany') && !names.has(f.targetModel)) {
        throw new Error(
          `model '${model.name}': field '${key}' references unknown model '${f.targetModel}'. ` +
            `Known models: ${[...names].join(', ') || '(none)'}`,
        );
      }
    }
  }
}

/**
 * Loads every models/**\/*.model.ts file via a native dynamic `import()` — Bun transpiles .ts on
 * the fly, no separate tsc build step or loader needed — and collects every ModelDefinition each
 * file exports. Does *not* validate the result —
 * a user model may legitimately reference a built-in model (e.g. `field.reference('users', ...)`)
 * that isn't visible here, so `generate()` (src/codegen/generate.ts) runs
 * `assertNoDuplicateNames`/`assertReferencesResolve` itself, against this list merged with
 * `BUILTIN_MODELS`, before any codegen runs.
 */
export async function scanModels(modelsDir: string): Promise<ScannedModel[]> {
  const files = await findModelFiles(modelsDir);
  const scanned: ScannedModel[] = [];

  for (const filePath of files) {
    const moduleUrl = pathToFileURL(filePath).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(moduleUrl)) as Record<string, unknown>;
    } catch (err) {
      // Name the file: a bare "field declares both 'required: true' and a 'default'" thrown while
      // a model module evaluates gives no clue which of N model files it came from.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`in ${path.relative(process.cwd(), filePath)}: ${message}`, { cause: err });
    }
    for (const [exportName, value] of Object.entries(mod)) {
      if (isModelDefinition(value)) {
        scanned.push({ filePath, exportName, model: value, domain: folderDomainOf(modelsDir, path.dirname(filePath)) });
      }
    }
  }

  return scanned;
}
