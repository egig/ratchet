import { User, Role, Session, Account, Verification } from '../auth/models/index.js';
import type { RatchetPlugin } from '../plugin/types.js';
import { Workspace, WorkspaceView } from '../workspace/models/index.js';
import type { ScannedModel } from './scan.js';
import type { ScannedDomain } from './scan-domains.js';
import type { ScannedForm } from './scan-forms.js';

/**
 * The framework's own built-in models — always part of the model graph `generate()` builds
 * from, without a consuming app declaring them under `models/`. Unlike a scanned user model,
 * there's no on-disk `filePath` to import from at codegen time; `registry-gen.ts`/
 * `validators-gen.ts` special-case a set `builtinPackage` to import from that package specifier
 * instead of a relative path. `domain` is set explicitly for the same reason (ADR 0001) — there's
 * no on-disk folder for `folderDomainOf` to infer it from.
 */
export const BUILTIN_MODELS: ScannedModel[] = [
  { filePath: '@egig/ratchet/auth (User)', exportName: 'User', model: User, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Role)', exportName: 'Role', model: Role, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Session)', exportName: 'Session', model: Session, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Account)', exportName: 'Account', model: Account, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Verification)', exportName: 'Verification', model: Verification, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/workspace (Workspace)', exportName: 'Workspace', model: Workspace, builtinPackage: '@egig/ratchet/workspace', domain: 'workspace' },
  { filePath: '@egig/ratchet/workspace (WorkspaceView)', exportName: 'WorkspaceView', model: WorkspaceView, builtinPackage: '@egig/ratchet/workspace', domain: 'workspace' },
];

/**
 * The framework's own built-in Domains — none today (feature packages contribute theirs through
 * the plugin contract, see `pluginScanEntries`). Kept so a future core Domain has a home.
 */
export const BUILTIN_DOMAINS: ScannedDomain[] = [];

/**
 * The framework's own built-in console forms — `generate()` merges these into every consuming
 * app's `customForms` map (`src/console/client/custom-forms.tsx`) by default, exactly as if the
 * app had authored its own `<name>.form.tsx`, unless it actually does: a scanned form for the same
 * model takes precedence and this entry is dropped (see `generate()`, generate.ts). Unlike
 * `BUILTIN_MODELS` above, there's no live object to import here — a `.form.tsx` is never
 * `import()`-ed by codegen itself (`scan-forms.ts`'s own doc comment), only ever referenced by the
 * *generated* `console-forms.ts`, which the browser bundle build resolves — so this is pure
 * metadata, the same shape a scanned form gets from `scanForms()`.
 */
export const BUILTIN_FORMS: ScannedForm[] = [
  {
    filePath: '@egig/ratchet/auth/console-forms (RoleForm)',
    modelName: 'roles',
    builtinPackage: '@egig/ratchet/auth/console-forms',
    exportName: 'RoleForm',
  },
];

/**
 * A plugin's models/domains/forms (`RatchetPlugin`, src/plugin/types.ts) as the same scan entries
 * a builtin gets — `module` plays `builtinPackage`'s role (a bare specifier the generated files
 * import each export from by name) and `domain` is assigned explicitly, as for builtins.
 */
export function pluginScanEntries(plugins: readonly RatchetPlugin[]): {
  models: ScannedModel[];
  domains: ScannedDomain[];
  forms: ScannedForm[];
} {
  const models: ScannedModel[] = [];
  const domains: ScannedDomain[] = [];
  const forms: ScannedForm[] = [];
  for (const p of plugins) {
    for (const [exportName, model] of Object.entries(p.models ?? {})) {
      models.push({ filePath: `${p.module} (${exportName})`, exportName, model, builtinPackage: p.module!, domain: p.domain });
    }
    for (const [exportName, domain] of Object.entries(p.domains ?? {})) {
      domains.push({ filePath: `${p.module} (${exportName})`, exportName, domain, builtinPackage: p.module! });
    }
    for (const f of p.forms ?? []) {
      forms.push({ filePath: `${f.module} (${f.exportName})`, modelName: f.modelName, builtinPackage: f.module, exportName: f.exportName });
    }
  }
  return { models, domains, forms };
}
