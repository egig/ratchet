import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { generate } from '../src/codegen/generate.js';
import { defineModel, defineDomain, field, wrapDb, type AnyDb } from '../src/core/index.js';
import { App } from '../src/router/index.js';
import { createRatchetApp } from '../src/server/index.js';
import { definePlugin, PLUGIN_API_VERSION, type RatchetPlugin } from '../src/plugin/index.js';

// The plugin contract (src/plugin/) exercised with a fake plugin — no real feature package needed.

const Gadget = defineModel('gadgets', { fields: { name: field.string({ required: true }) } });
const FakeDomain = defineDomain('fake', {});

function fakePlugin(overrides: Partial<RatchetPlugin> = {}): RatchetPlugin {
  return definePlugin({
    name: 'fake',
    apiVersion: PLUGIN_API_VERSION,
    module: '@acme/fake',
    domain: 'fake',
    models: { Gadget },
    domains: { FakeDomain },
    forms: [{ modelName: 'gadgets', module: '@acme/fake/console', exportName: 'GadgetForm' }],
    console: '@acme/fake/console',
    ...overrides,
  });
}

describe('plugin contract — codegen', () => {
  let modelsDir: string;
  let generatedDir: string;

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(os.tmpdir(), 'ratchet-plugin-models-'));
    generatedDir = await mkdtemp(path.join(os.tmpdir(), 'ratchet-plugin-gen-'));
  });
  afterEach(async () => {
    await rm(modelsDir, { recursive: true, force: true });
    await rm(generatedDir, { recursive: true, force: true });
  });

  const read = (file: string) => readFile(path.join(generatedDir, file), 'utf8');

  it("joins a plugin's models, domains and forms into the generated files, imported from its `module`", async () => {
    const result = await generate({ modelsDir, generatedDir, plugins: [fakePlugin()] });
    expect(result.modelCount).toBe(8); // 5 auth + 2 workspace built-ins + the plugin's 1
    expect(result.domainCount).toBe(1);

    const registry = await read('registry.ts');
    expect(registry).toContain(`import { Gadget as _Gadget } from '@acme/fake';`);
    expect(registry).toContain(`export const Gadget = { ..._Gadget, console: { ..._Gadget.console, domain: "fake" } };`);
    expect(await read('domains.ts')).toContain(`export { FakeDomain } from '@acme/fake';`);
    expect(await read('schema.ts')).toContain("pgTable('gadgets'");
    expect(await read('console-forms.ts')).toContain('@acme/fake/console');
  });

  it("lists every plugin console module in console-plugins.ts, in order", async () => {
    await generate({
      modelsDir,
      generatedDir,
      plugins: [fakePlugin({ console: ['@acme/fake/a', '@acme/fake/b'] })],
    });
    const src = await read('console-plugins.ts');
    expect(src).toContain(`import plugin0 from '@acme/fake/a';`);
    expect(src).toContain(`import plugin1 from '@acme/fake/b';`);
    expect(src).toContain('export const consolePlugins: ConsolePlugin[] = [plugin0, plugin1];');
  });

  it('emits an empty console-plugins.ts without plugins', async () => {
    await generate({ modelsDir, generatedDir });
    expect(await read('console-plugins.ts')).toContain('export const consolePlugins: ConsolePlugin[] = [];');
  });

  it('makes app.ts carry `config.plugins` only when given the config file', async () => {
    await generate({ modelsDir, generatedDir });
    expect(await read('app.ts')).not.toContain('plugins');
    await generate({ modelsDir, generatedDir, configFile: path.join(modelsDir, '..', 'ratchet.config.ts') });
    const app = await read('app.ts');
    expect(app).toMatch(/import config from '\.\.\/ratchet\.config\.js';/);
    expect(app).toContain('plugins: config.plugins ?? [],');
  });

  it('rejects a plugin built for another plugin API version', async () => {
    await expect(generate({ modelsDir, generatedDir, plugins: [fakePlugin({ apiVersion: 999 })] })).rejects.toThrow(
      /targets plugin API v999/,
    );
  });

  it('rejects models without a `module` to import them from', async () => {
    await expect(generate({ modelsDir, generatedDir, plugins: [fakePlugin({ module: undefined })] })).rejects.toThrow(
      /no `module` specifier/,
    );
  });

  it('rejects a duplicate plugin name and an unmet `requires`', async () => {
    await expect(generate({ modelsDir, generatedDir, plugins: [fakePlugin(), fakePlugin()] })).rejects.toThrow(
      /listed twice/,
    );
    await expect(
      generate({ modelsDir, generatedDir, plugins: [fakePlugin({ requires: ['billing'] })] }),
    ).rejects.toThrow(/requires plugin 'billing'/);
  });
});

describe('plugin contract — createRatchetApp', () => {
  let client: Client;
  let db: AnyDb;

  beforeEach(() => {
    client = createClient({ url: 'file::memory:' });
    db = wrapDb(drizzle(client), 'sqlite');
  });
  afterEach(() => client.close());

  function routerReplying(body: string): App {
    const app = new App();
    app.get('/ping', (c) => c.json({ body }));
    return app;
  }

  it("mounts a plugin's routes ahead of the generic /api/:model router", async () => {
    const app = await createRatchetApp({
      db,
      bundle: { models: {}, domains: {}, plugins: [fakePlugin({ routes: () => [{ prefix: '/api/fake', app: routerReplying('fake') }] })] },
    });
    const res = await app.request('/api/fake/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: 'fake' });
  });

  it('rejects a prefix that would shadow a model, a reserved prefix, or another plugin', async () => {
    const shadowing = fakePlugin({ routes: () => [{ prefix: '/api/gadgets', app: new App() }] });
    await expect(createRatchetApp({ db, bundle: { models: { gadgets: Gadget }, domains: {}, plugins: [shadowing] } })).rejects.toThrow(
      /would shadow the generic '\/api\/gadgets'/,
    );

    // a hidden model has no generic routes, so its own plugin may serve it under the same segment
    const Hidden = defineModel('hiddens', { api: { hidden: true }, fields: { name: field.string() } });
    const owning = fakePlugin({ routes: () => [{ prefix: '/api/hiddens', app: routerReplying('own') }] });
    const app = await createRatchetApp({ db, bundle: { models: { hiddens: Hidden }, domains: {}, plugins: [owning] } });
    expect(await (await app.request('/api/hiddens/ping')).json()).toEqual({ body: 'own' });

    const reserved = fakePlugin({ routes: () => [{ prefix: '/api/auth', app: new App() }] });
    await expect(createRatchetApp({ db, bundle: { models: {}, domains: {}, plugins: [reserved] } })).rejects.toThrow(/reserved/);

    const a = fakePlugin({ name: 'a', routes: () => [{ prefix: '/api/x', app: new App() }] });
    const b = fakePlugin({ name: 'b', routes: () => [{ prefix: '/api/x', app: new App() }] });
    await expect(createRatchetApp({ db, bundle: { models: {}, domains: {}, plugins: [a, b] } })).rejects.toThrow(
      /both mount '\/api\/x'/,
    );
  });

  it('applies decorateDb before routers are built and exposes services to later plugins', async () => {
    let decorated: AnyDb | undefined;
    let seenByRoutes: AnyDb | undefined;
    let seenService: unknown;
    const provider = fakePlugin({
      name: 'provider',
      decorateDb: (inner) => (decorated = { ...inner }),
      service: () => ({ hello: 'world' }),
    });
    const consumer = fakePlugin({
      name: 'consumer',
      optional: ['provider', 'missing'],
      routes: (ctx) => {
        seenByRoutes = ctx.db;
        seenService = ctx.plugins.provider;
        return [];
      },
    });
    await createRatchetApp({ db, bundle: { models: {}, domains: {}, plugins: [provider, consumer] } });
    expect(seenByRoutes).toBe(decorated!);
    expect(seenService).toEqual({ hello: 'world' });
  });

  it('always includes the built-in workspace plugin service', async () => {
    let services: Record<string, unknown> = {};
    const probe = fakePlugin({ routes: (ctx) => ((services = ctx.plugins), []) });
    await createRatchetApp({ db, bundle: { models: {}, domains: {}, plugins: [probe] } });
    expect(typeof (services.workspace as { snapshot?: unknown })?.snapshot).toBe('function');
  });
});
