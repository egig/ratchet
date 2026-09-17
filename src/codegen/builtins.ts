import { workflowModels } from '../workflows/models.js';
import { User, Role, Session } from '../auth/models/index.js';
import { Agent, Chat, Message, Provider } from '../automation/models/index.js';
import { AutomationDomain } from '../automation/domain.js';
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
  ...workflowModels.map((model, i) => ({ filePath: '@egig/ratchet/workflows', exportName: ['Workflow','WorkflowVersion','WorkflowRun','WorkflowStep','WorkflowOutbox'][i]!, model, builtinPackage: '@egig/ratchet/workflows', domain: 'automation' })),
  { filePath: '@egig/ratchet/auth (User)', exportName: 'User', model: User, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Role)', exportName: 'Role', model: Role, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/auth (Session)', exportName: 'Session', model: Session, builtinPackage: '@egig/ratchet/auth', domain: 'auth' },
  { filePath: '@egig/ratchet/automation (Provider)', exportName: 'Provider', model: Provider, builtinPackage: '@egig/ratchet/automation', domain: 'automation' },
  { filePath: '@egig/ratchet/automation (Agent)', exportName: 'Agent', model: Agent, builtinPackage: '@egig/ratchet/automation', domain: 'automation' },
  { filePath: '@egig/ratchet/automation (Chat)', exportName: 'Chat', model: Chat, builtinPackage: '@egig/ratchet/automation', domain: 'automation' },
  { filePath: '@egig/ratchet/automation (Message)', exportName: 'Message', model: Message, builtinPackage: '@egig/ratchet/automation', domain: 'automation' },
  { filePath: '@egig/ratchet/workspace (Workspace)', exportName: 'Workspace', model: Workspace, builtinPackage: '@egig/ratchet/workspace', domain: 'workspace' },
  { filePath: '@egig/ratchet/workspace (WorkspaceView)', exportName: 'WorkspaceView', model: WorkspaceView, builtinPackage: '@egig/ratchet/workspace', domain: 'workspace' },
];

/**
 * The framework's own built-in Domains — same reasoning as `BUILTIN_MODELS` above: the Automation
 * Domain's `consoleMenu` (its Chat link) has no on-disk `*.domain.ts` file to be scanned from.
 */
export const BUILTIN_DOMAINS: ScannedDomain[] = [
  {
    filePath: '@egig/ratchet/automation (AutomationDomain)',
    exportName: 'AutomationDomain',
    domain: AutomationDomain,
    builtinPackage: '@egig/ratchet/automation',
  },
];

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
