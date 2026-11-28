// Fails when code under plugins/ reaches into the framework by relative path instead of its public
// `@egig/ratchet/*` specifiers (+ `PluginContext`). Run by `bun run typecheck`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');
const SRC = path.join(ROOT, 'src');
const violations: string[] = [];

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) {
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /from\s+['"](\.[^'"]+)['"]/.exec(line) ?? /import\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(line);
        if (m && path.resolve(path.dirname(full), m[1]!).startsWith(SRC + path.sep)) {
          violations.push(`${path.relative(ROOT, full)}:${i + 1}: ${m[1]}`);
        }
      });
    }
  }
}

walk(PLUGINS);
if (violations.length > 0) {
  console.error('plugins must import @egig/ratchet through its public specifiers, not src/ paths:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
