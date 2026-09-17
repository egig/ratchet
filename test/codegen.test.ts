import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generate } from '../src/codegen/generate.js';

// Self-contained fixtures — deliberately not the real models/ directory, which is gitignored
// example "app" content (see DESIGN.md), not part of the framework's own tracked test suite.
const CORE_INDEX_FILE = fileURLToPath(new URL('../src/core/index.ts', import.meta.url));
const CORE_IMPORT = pathToFileURL(CORE_INDEX_FILE).href;

const CUSTOMER_MODEL = `
import { defineModel, field } from '${CORE_IMPORT}';

export const Customer = defineModel('customers', {
  fields: {
    name: field.string({ required: true, maxLength: 255 }),
    email: field.string({ required: true, unique: true, indexed: true, maxLength: 320 }),
  },
});
`;

const INVOICE_MODEL = `
import { defineModel, field } from '${CORE_IMPORT}';

export const Invoice = defineModel('invoices', {
  fields: {
    customerId: field.reference('customers', { required: true, indexed: true }),
    amount: field.decimal({ precision: 10, scale: 2, required: true }),
    status: field.enum(['draft', 'sent', 'paid'], { default: 'draft', indexed: true }),
  },
});
`;

async function writeModelsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ratchet-models-'));
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  return dir;
}

describe('generate() against a self-contained model fixture', () => {
  let modelsDir: string;
  let generatedDir: string;

  beforeEach(async () => {
    modelsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'invoice.model.ts': INVOICE_MODEL,
    });
    generatedDir = await mkdtemp(path.join(os.tmpdir(), 'ratchet-gen-'));
  });

  afterEach(async () => {
    await rm(modelsDir, { recursive: true, force: true });
    await rm(generatedDir, { recursive: true, force: true });
  });

  it('emits a schema with §4 conventions: timestamptz, partial unique index, CHECK, RESTRICT FK', async () => {
    const { modelCount } = await generate({ modelsDir, generatedDir });
    // 2 user models + 3 built-in auth models (User/Role/Session) + 4 built-in
    // automation models (Agent/Chat/Message/Provider) + 2 built-in workspace
    // models (Workspace/WorkspaceView) + 5 workflow models — built-ins are always present.
    expect(modelCount).toBe(16);

    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );

    expect(schemaSrc).toContain("timestamp('created_at', { withTimezone: true })");
    expect(schemaSrc).toContain("timestamp('deleted_at', { withTimezone: true })");
    expect(schemaSrc).toContain('uniqueIndex(');
    expect(schemaSrc).toContain('.where(sql`${table.deletedAt} IS NULL`)');
    expect(schemaSrc).toContain("check('invoices_status_check'");
    expect(schemaSrc).toContain("onDelete: 'restrict'");
    // Q9: never gen_random_uuid() — id is app-generated (uuidv7), so the column has no DB default.
    expect(schemaSrc).not.toContain('defaultRandom');
    expect(schemaSrc).not.toContain('gen_random_uuid');
  });

  it('emits validators that import the framework via the bare `@egig/ratchet/core` specifier, not a filesystem path', async () => {
    await generate({ modelsDir, generatedDir });
    const validatorsSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'validators.ts'), 'utf8'),
    );
    // this file lives inside a *consuming* project's tree — only a bare specifier resolves
    // correctly there regardless of package-manager layout (see validators-gen.ts).
    expect(validatorsSrc).toContain("from '@egig/ratchet/core'");
    expect(validatorsSrc).toContain('buildCreateSchema(Invoice)');
    expect(validatorsSrc).toContain('buildUpdateSchema(Invoice)');
  });

  it('emits a registry with static re-exports, one per model (routing pivot)', async () => {
    await generate({ modelsDir, generatedDir });
    const registrySrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
    );
    expect(registrySrc).toContain('export { Customer }');
    expect(registrySrc).toContain('export { Invoice }');
  });

  it('always includes the built-in User/Role/Session models, imported from `@egig/ratchet/auth`', async () => {
    await generate({ modelsDir, generatedDir });
    const registrySrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
    );
    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );
    // built-ins are wrapped, not plain re-exports, since they're assigned the 'auth' Domain
    // explicitly (builtins.ts) — see the 'auth' Domain assertions below.
    for (const name of ['User', 'Role', 'Session']) {
      expect(registrySrc).toContain(`import { ${name} as _${name} } from '@egig/ratchet/auth';`);
    }
    expect(schemaSrc).toContain("pgTable('users'");
    expect(schemaSrc).toContain("pgTable('roles'");
    expect(schemaSrc).toContain("pgTable('sessions'");
  });

  it('always includes the built-in Workspace/WorkspaceView models, imported from `@egig/ratchet/workspace`', async () => {
    await generate({ modelsDir, generatedDir });
    const registrySrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
    );
    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );
    for (const name of ['Workspace', 'WorkspaceView']) {
      expect(registrySrc).toContain(`import { ${name} as _${name} } from '@egig/ratchet/workspace';`);
    }
    expect(schemaSrc).toContain("pgTable('workspaces'");
    expect(schemaSrc).toContain("pgTable('workspace_views'");
  });

  it('always includes the built-in Agent/Chat/Message/Provider models, imported from `@egig/ratchet/automation`', async () => {
    await generate({ modelsDir, generatedDir });
    const registrySrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
    );
    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );
    for (const name of ['Agent', 'Chat', 'Message', 'Provider']) {
      expect(registrySrc).toContain(`import { ${name} as _${name} } from '@egig/ratchet/automation';`);
    }
    expect(schemaSrc).toContain("pgTable('agents'");
    expect(schemaSrc).toContain("pgTable('chats'");
    expect(schemaSrc).toContain("pgTable('messages'");
    expect(schemaSrc).toContain("pgTable('providers'");
  });

  it("assigns the built-in auth models to the 'auth' Domain, the built-in automation models to the 'automation' Domain, and the built-in workspace models to the 'workspace' Domain (ADR 0001), grouping them in the console sidebar", async () => {
    await generate({ modelsDir, generatedDir });
    const registrySrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
    );
    for (const name of ['User', 'Role', 'Session']) {
      expect(registrySrc).toContain(`domain: "auth"`);
      expect(registrySrc).toContain(`export const ${name} = { ..._${name}, console: { ..._${name}.console, domain: "auth" } };`);
    }
    for (const name of ['Agent', 'Chat', 'Message', 'Provider']) {
      expect(registrySrc).toContain(`domain: "automation"`);
      expect(registrySrc).toContain(`export const ${name} = { ..._${name}, console: { ..._${name}.console, domain: "automation" } };`);
    }
    for (const name of ['Workspace', 'WorkspaceView']) {
      expect(registrySrc).toContain(`domain: "workspace"`);
      expect(registrySrc).toContain(`export const ${name} = { ..._${name}, console: { ..._${name}.console, domain: "workspace" } };`);
    }
    // a flat, non-domain user model (customer.model.ts, invoice.model.ts) stays a plain re-export.
    expect(registrySrc).toContain('export { Customer } from');
    expect(registrySrc).toContain('export { Invoice } from');
  });

  it("emits `roles.permissions` as a jsonb column and `agents.role_id` as a nullable FK — grants live on Role, not junction tables", async () => {
    await generate({ modelsDir, generatedDir });
    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );
    expect(schemaSrc).not.toContain("pgTable('permissions'");
    expect(schemaSrc).not.toContain("pgTable('agent_permissions'");
    expect(schemaSrc).toMatch(/permissions:\s*jsonb\('permissions'\)/);
    expect(schemaSrc).toMatch(/roleId:\s*uuid\('role_id'\)/);
  });

  it('a model declared under a modelsDir subdirectory is assigned that folder name as its Domain', async () => {
    const domainModelsDir = await writeModelsDir({
      'billing/invoice.model.ts': `
        import { defineModel, field } from '${CORE_IMPORT}';
        export const Invoice = defineModel('invoices', {
          fields: { amount: field.decimal({ precision: 10, scale: 2, required: true }) },
        });
      `,
    });
    try {
      await generate({ modelsDir: domainModelsDir, generatedDir });
      const registrySrc = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(generatedDir, 'registry.ts'), 'utf8'),
      );
      expect(registrySrc).toContain(`console: { ..._Invoice.console, domain: "billing" } };`);
    } finally {
      await rm(domainModelsDir, { recursive: true, force: true });
    }
  });

  it('emits the shared ratchet_domain_settings table unconditionally', async () => {
    await generate({ modelsDir, generatedDir });
    const schemaSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'schema.ts'), 'utf8'),
    );
    expect(schemaSrc).toContain("pgTable('ratchet_domain_settings'");
  });

  it('emits Domain Settings (a *.domain.ts under a matching modelsDir subdirectory) to domains.ts', async () => {
    const domainModelsDir = await writeModelsDir({
      'auth/settings.domain.ts': `
        import { defineDomain, field } from '${CORE_IMPORT}';
        export const AuthSettings = defineDomain('auth', {
          label: 'Authentication',
          settings: { sessionTtlDays: field.integer({ default: 7 }) },
        });
      `,
    });
    try {
      const { domainCount } = await generate({ modelsDir: domainModelsDir, generatedDir });
      // 1 user Domain + 1 built-in Automation Domain (always present, see below).
      expect(domainCount).toBe(2);
      const domainsSrc = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(generatedDir, 'domains.ts'), 'utf8'),
      );
      expect(domainsSrc).toContain('export { AuthSettings }');
    } finally {
      await rm(domainModelsDir, { recursive: true, force: true });
    }
  });

  it('always includes the built-in Automation Domain (Chat console menu), imported from `@egig/ratchet/automation`', async () => {
    const { domainCount } = await generate({ modelsDir, generatedDir });
    expect(domainCount).toBe(1);
    const domainsSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'domains.ts'), 'utf8'),
    );
    expect(domainsSrc).toContain(`export { AutomationDomain } from '@egig/ratchet/automation';`);
  });

  it("rejects Domain Settings declared under a folder that doesn't match their own domain name", async () => {
    const badDomainModelsDir = await writeModelsDir({
      'billing/settings.domain.ts': `
        import { defineDomain, field } from '${CORE_IMPORT}';
        export const AuthSettings = defineDomain('auth', { settings: { x: field.boolean() } });
      `,
    });
    try {
      await expect(generate({ modelsDir: badDomainModelsDir, generatedDir })).rejects.toThrow(
        /must live under 'models\/auth\/'/,
      );
    } finally {
      await rm(badDomainModelsDir, { recursive: true, force: true });
    }
  });

  it('rejects a dangling field.reference target before writing any files', async () => {
    const badModelsDir = await writeModelsDir({
      'orphan.model.ts': `
        import { defineModel, field } from '${CORE_IMPORT}';
        export const Orphan = defineModel('orphans', {
          fields: { ownerId: field.reference('nonexistent', { required: true }) },
        });
      `,
    });
    try {
      await expect(generate({ modelsDir: badModelsDir, generatedDir })).rejects.toThrow(
        /references unknown model 'nonexistent'/,
      );
    } finally {
      await rm(badModelsDir, { recursive: true, force: true });
    }
  });

  it("emits the builtin RoleForm entry to console-forms.ts when the app declares no *.form.tsx of its own", async () => {
    const { formCount } = await generate({ modelsDir, generatedDir });
    expect(formCount).toBe(1); // BUILTIN_FORMS' RoleForm (builtins.ts) — always present by default
    const formsSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'console-forms.ts'), 'utf8'),
    );
    expect(formsSrc).toContain('export const customForms: Record<string, ModelFormComponent> = {');
    expect(formsSrc).toContain("from '@egig/ratchet/console/client'");
    expect(formsSrc).toContain(`import { RoleForm as rolesForm } from '@egig/ratchet/auth/console-forms';`);
    expect(formsSrc).toContain(`"roles": rolesForm,`);
  });

  it("emits a customForms entry for a `<model.name>.form.tsx`, imported by relative path (not the file's own basename)", async () => {
    const formsModelsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      // CUSTOMER_MODEL's model name is 'customers' (defineModel('customers', ...)) — the form
      // file is keyed off that, not off `customer.model.ts`'s own basename.
      'customers.form.tsx': `export default function CustomersForm() { return null; }`,
    });
    try {
      const { formCount } = await generate({ modelsDir: formsModelsDir, generatedDir });
      expect(formCount).toBe(2); // the scanned customers form, plus the builtin RoleForm
      const formsSrc = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(generatedDir, 'console-forms.ts'), 'utf8'),
      );
      expect(formsSrc).toContain(`import customersForm from '../`);
      expect(formsSrc).toContain(`customers.form.tsx';`);
      expect(formsSrc).toContain(`"customers": customersForm,`);
    } finally {
      await rm(formsModelsDir, { recursive: true, force: true });
    }
  });

  it("a scanned `roles.form.tsx` overrides the builtin RoleForm instead of colliding with it", async () => {
    const formsModelsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'roles.form.tsx': `export default function CustomRoleForm() { return null; }`,
    });
    try {
      const { formCount } = await generate({ modelsDir: formsModelsDir, generatedDir });
      expect(formCount).toBe(1); // the app's own roles.form.tsx replaces the builtin RoleForm
      const formsSrc = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(generatedDir, 'console-forms.ts'), 'utf8'),
      );
      expect(formsSrc).not.toContain('@egig/ratchet/auth/console-forms');
      expect(formsSrc).toContain(`import rolesForm from '../`);
      expect(formsSrc).toContain(`"roles": rolesForm,`);
    } finally {
      await rm(formsModelsDir, { recursive: true, force: true });
    }
  });

  it('rejects a console form declared for a model that does not exist', async () => {
    const badFormsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'orphan.form.tsx': `export default function OrphanForm() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: badFormsDir, generatedDir })).rejects.toThrow(
        /declares a form for unknown model 'orphan'/,
      );
    } finally {
      await rm(badFormsDir, { recursive: true, force: true });
    }
  });

  it('rejects two console forms declared for the same model', async () => {
    const dupFormsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'customers.form.tsx': `export default function A() { return null; }`,
      'billing/customers.form.tsx': `export default function B() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: dupFormsDir, generatedDir })).rejects.toThrow(
        /duplicate console form for model 'customers'/,
      );
    } finally {
      await rm(dupFormsDir, { recursive: true, force: true });
    }
  });

  it('emits an empty fieldInputs map to console-field-inputs.ts when no *.input.tsx exists', async () => {
    const { fieldInputCount } = await generate({ modelsDir, generatedDir });
    expect(fieldInputCount).toBe(0);
    const fieldInputsSrc = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(generatedDir, 'console-field-inputs.ts'), 'utf8'),
    );
    expect(fieldInputsSrc).toContain('export const fieldInputs: Record<string, Record<string, FieldRenderer>> = {');
    expect(fieldInputsSrc).toContain("from '@egig/ratchet/console/client'");
  });

  it("emits a fieldInputs entry for a `<model>.<field>.input.tsx`, imported by relative path", async () => {
    const fieldInputsModelsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      // CUSTOMER_MODEL's model name is 'customers' (defineModel('customers', ...)) with an
      // 'email' field.
      'customers.email.input.tsx': `export default function CustomersEmailInput() { return null; }`,
    });
    try {
      const { fieldInputCount } = await generate({ modelsDir: fieldInputsModelsDir, generatedDir });
      expect(fieldInputCount).toBe(1);
      const fieldInputsSrc = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(generatedDir, 'console-field-inputs.ts'), 'utf8'),
      );
      expect(fieldInputsSrc).toContain(`import customers_emailInput from '../`);
      expect(fieldInputsSrc).toContain(`customers.email.input.tsx';`);
      expect(fieldInputsSrc).toContain(`"customers": {`);
      expect(fieldInputsSrc).toContain(`"email": customers_emailInput,`);
    } finally {
      await rm(fieldInputsModelsDir, { recursive: true, force: true });
    }
  });

  it('rejects a console field input declared for a model that does not exist', async () => {
    const badFieldInputsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'orphan.email.input.tsx': `export default function OrphanEmailInput() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: badFieldInputsDir, generatedDir })).rejects.toThrow(
        /declares an input for unknown model 'orphan'/,
      );
    } finally {
      await rm(badFieldInputsDir, { recursive: true, force: true });
    }
  });

  it('rejects a console field input declared for a field that does not exist on that model', async () => {
    const badFieldInputsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'customers.nickname.input.tsx': `export default function CustomersNicknameInput() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: badFieldInputsDir, generatedDir })).rejects.toThrow(
        /declares an input for unknown field 'nickname' on model 'customers'/,
      );
    } finally {
      await rm(badFieldInputsDir, { recursive: true, force: true });
    }
  });

  it('rejects two console field inputs declared for the same model+field', async () => {
    const dupFieldInputsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'customers.email.input.tsx': `export default function A() { return null; }`,
      'billing/customers.email.input.tsx': `export default function B() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: dupFieldInputsDir, generatedDir })).rejects.toThrow(
        /duplicate console field input for 'customers.email'/,
      );
    } finally {
      await rm(dupFieldInputsDir, { recursive: true, force: true });
    }
  });

  it("rejects a *.input.tsx not named '<model>.<field>.input.tsx'", async () => {
    const badFieldInputsDir = await writeModelsDir({
      'customer.model.ts': CUSTOMER_MODEL,
      'customers.input.tsx': `export default function BadInput() { return null; }`,
    });
    try {
      await expect(generate({ modelsDir: badFieldInputsDir, generatedDir })).rejects.toThrow(
        /must be named '<model>\.<field>\.input\.tsx'/,
      );
    } finally {
      await rm(badFieldInputsDir, { recursive: true, force: true });
    }
  });
});
