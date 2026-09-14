import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { buildServerBundle } from '../src/cli/build-console.js';

const REGISTRY_FIXTURE = 'export const models = {};\n';
const DOMAINS_FIXTURE = 'export const domains = {};\n';
const APP_ROUTES_SERVER_FIXTURE = 'export const routes = [];\nexport const resourceRouteIds = new Set();\n';
const APP_BUNDLE_NO_WEB = 'export const bundle = { models: {}, domains: {} };\n';
const APP_BUNDLE_WEB = 'export const bundle = { models: {}, domains: {}, web: { routes: [], resourceRouteIds: new Set() } };\n';

interface Fixture {
  cwd: string;
  dirs: {
    generatedDir: string;
    routesDir: string;
    publicDir: string;
    modelsDir: string;
    migrationsDir: string;
    consolePath: string;
    brand: Record<string, unknown>;
  };
}

async function makeFixture(withWeb: boolean): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'ratchet-server-bundle-'));
  const generatedDir = path.join(cwd, '.ratchet');
  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, 'registry.ts'), REGISTRY_FIXTURE, 'utf8');
  await writeFile(path.join(generatedDir, 'domains.ts'), DOMAINS_FIXTURE, 'utf8');
  await writeFile(path.join(generatedDir, 'app.ts'), withWeb ? APP_BUNDLE_WEB : APP_BUNDLE_NO_WEB, 'utf8');
  if (withWeb) {
    await writeFile(path.join(generatedDir, 'app-routes.server.ts'), APP_ROUTES_SERVER_FIXTURE, 'utf8');
  }
  return {
    cwd,
    dirs: {
      generatedDir,
      routesDir: path.join(cwd, 'routes'),
      publicDir: path.join(cwd, 'public'),
      modelsDir: path.join(cwd, 'models'),
      migrationsDir: path.join(cwd, 'migrations'),
      consolePath: '/console',
      brand: {},
    },
  };
}

describe('buildServerBundle', () => {
  let cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true });
    cleanup = [];
  });

  it('emits a trivial createRatchetApp entry without web wiring when the site is not opted into', async () => {
    const { cwd, dirs } = await makeFixture(false);
    cleanup.push(cwd);

    await buildServerBundle(cwd, dirs, { connectionString: 'postgres://test' });

    const entrySrc = await readFile(path.join(dirs.generatedDir, 'server-entry.ts'), 'utf8');
    expect(entrySrc).toContain("import { createRatchetApp } from '@egig/ratchet/server';");
    expect(entrySrc).toContain("import { bundle } from './app.js';");
    expect(entrySrc).toContain('consoleAssets: createNodeFsAssetSource(".ratchet")');
    expect(entrySrc).toContain('consolePath: "/console"');
    expect(entrySrc).not.toContain('web:');
    expect(existsSync(path.join(cwd, 'dist', 'server.js'))).toBe(true);
  });

  it('passes web runtime paths to createRatchetApp when routes/root.tsx exists', async () => {
    const { cwd, dirs } = await makeFixture(true);
    cleanup.push(cwd);

    await buildServerBundle(cwd, dirs, { connectionString: 'postgres://test' });

    const entrySrc = await readFile(path.join(dirs.generatedDir, 'server-entry.ts'), 'utf8');
    expect(entrySrc).toContain('web: { entrySrc: "/_ratchet/entry.client.js", publicDir: "public", generatedDir: ".ratchet" }');
    expect(existsSync(path.join(cwd, 'dist', 'server.js'))).toBe(true);
  });
});
