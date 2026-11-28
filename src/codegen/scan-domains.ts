import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DomainDefinition } from '../core/domain.js';
import { folderDomainOf } from './domain-path.js';

export interface ScannedDomain {
  filePath: string;
  exportName: string;
  domain: DomainDefinition;
  /** set for the framework's own built-in Domains (src/codegen/builtins.ts) — e.g.
   * `'@egig/ratchet-automation'` for a plugin's Domain. When set, codegen imports the Domain
   * from this package specifier instead of a relative filesystem path, and `assertDomainMatchesFolder`
   * skips it (there's no on-disk folder for a builtin to live under). */
  builtinPackage?: string;
}

/** Duck-types a `defineDomain()` result — checked against `!('operations' in value)` so a
 * `*.domain.ts` file that re-exports a `ModelDefinition` (which also has a string `name`) is never
 * mistaken for one; a Domain never has `operations`, only a Model does. */
function isDomainDefinition(value: unknown): value is DomainDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DomainDefinition).name === 'string' &&
    !('operations' in value)
  );
}

async function findDomainFiles(modelsDir: string): Promise<string[]> {
  const entries = await readdir(modelsDir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.domain.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Loads every `models/**\/*.domain.ts` file's `defineDomain()` exports, mirroring `scanModels`
 * (scan.ts). Does *not* validate the result — `generate()` runs
 * `assertNoDuplicateDomainNames`/`assertDomainMatchesFolder` itself once the whole list is in hand. */
export async function scanDomains(modelsDir: string): Promise<ScannedDomain[]> {
  const files = await findDomainFiles(modelsDir);
  const scanned: ScannedDomain[] = [];

  for (const filePath of files) {
    const moduleUrl = pathToFileURL(filePath).href;
    const mod = (await import(moduleUrl)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (isDomainDefinition(value)) {
        scanned.push({ filePath, exportName, domain: value });
      }
    }
  }

  return scanned;
}

export function assertNoDuplicateDomainNames(scanned: ScannedDomain[]): void {
  const seen = new Map<string, string>();
  for (const { domain, filePath } of scanned) {
    const existing = seen.get(domain.name);
    if (existing) {
      throw new Error(
        `duplicate Domain declaration for '${domain.name}' declared in both '${existing}' and '${filePath}' — a Domain has at most one \`defineDomain()\` definition.`,
      );
    }
    seen.set(domain.name, filePath);
  }
}

/** ADR 0001: a Model's Domain is inferred from folder structure, and a declared Domain must agree
 * with it — a `defineDomain('auth', ...)` declared outside `models/auth/` (or at `modelsDir`'s
 * root) would silently apply to a Domain no model actually belongs to. */
export function assertDomainMatchesFolder(modelsDir: string, scanned: ScannedDomain[]): void {
  for (const { domain, filePath, builtinPackage } of scanned) {
    if (builtinPackage) continue;
    const folderDomain = folderDomainOf(modelsDir, path.dirname(filePath));
    if (folderDomain !== domain.name) {
      const foundIn = folderDomain ? `models/${folderDomain}/` : 'modelsDir root';
      throw new Error(
        `Domain '${domain.name}' (declared in '${filePath}') must live under 'models/${domain.name}/' — found under '${foundIn}' instead.`,
      );
    }
  }
}
