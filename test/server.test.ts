import { describe, expect, it } from 'bun:test';
import { createRatchetApp, type RatchetBundle } from '../src/server/index.js';
import type { ConsoleAssetSource } from '../src/console/router.js';

// `createRatchetApp` is pure route assembly — the routers it mounts don't touch `db` until a
// request actually reaches a handler, so a bare stub is enough to exercise mounting/precedence.
const db = {} as never;

const emptyBundle: RatchetBundle = { models: {}, domains: {} };

/** Asset source that reports "not built yet" — enough to prove the console router is mounted
 * (its shell handler answers 503, not the app-level text/plain 404). */
const notBuiltAssets: ConsoleAssetSource = {
  getManifest: async () => null,
  getAsset: async () => null,
};

async function status(app: Awaited<ReturnType<typeof createRatchetApp>>, path: string): Promise<number> {
  return (await app.request(path)).status;
}

describe('createRatchetApp', () => {
  it('always mounts the feature routers', async () => {
    const app = await createRatchetApp({ db, bundle: emptyBundle });

    // a real route on each always-on router — not the app-level 404
    expect(await status(app, '/api/auth/me')).not.toBe(404);
    // feature packages (automation, ...) mount only through `bundle.plugins` — see plugin-contract.test.ts
    // `/_site-assets/:domain/:field/:token` — unknown domain → the router's own 404 (JSON body),
    // but it's the router answering, so the path structurally matched
    const siteAssets = await app.request('/_site-assets/x/y/z');
    expect(siteAssets.headers.get('content-type')).toContain('application/json');
  });

  it('does not mount the console unless consoleAssets is supplied', async () => {
    const app = await createRatchetApp({ db, bundle: emptyBundle });
    const res = await app.request('/console');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain'); // app-level 404, not the console
  });

  it('mounts the console when consoleAssets is supplied', async () => {
    const app = await createRatchetApp({ db, bundle: emptyBundle, consoleAssets: notBuiltAssets });
    expect(await status(app, '/console')).toBe(503); // console shell: "not built yet"
  });

  it('keeps /api and /_site-assets ahead of a console mounted at /', async () => {
    const app = await createRatchetApp({
      db,
      bundle: emptyBundle,
      consoleAssets: notBuiltAssets,
      consolePath: '/',
    });
    // console at '/' has a `/*` catch-all — these must still reach their own routers
    expect(await status(app, '/')).toBe(503); // the console itself
    expect(await status(app, '/api/auth/me')).not.toBe(503);
    expect(await status(app, '/api/auth/me')).not.toBe(404);
    const siteAssets = await app.request('/_site-assets/x/y/z');
    expect(siteAssets.headers.get('content-type')).toContain('application/json');
  });

  it('rejects a consolePath that collides with /api', async () => {
    await expect(
      createRatchetApp({ db, bundle: emptyBundle, consoleAssets: notBuiltAssets, consolePath: '/api/x' }),
    ).rejects.toThrow(/collides/);
    await expect(
      createRatchetApp({ db, bundle: emptyBundle, consoleAssets: notBuiltAssets, consolePath: 'console' }),
    ).rejects.toThrow(/must start with/);
    await expect(
      createRatchetApp({ db, bundle: emptyBundle, consoleAssets: notBuiltAssets, consolePath: '/console/' }),
    ).rejects.toThrow(/trailing slash/);
  });

  it('throws when web options are given but the bundle has no web routes', async () => {
    await expect(
      createRatchetApp({
        db,
        bundle: emptyBundle,
        web: { entrySrc: '/_ratchet/entry.client.js', generatedDir: '.ratchet' },
      }),
    ).rejects.toThrow(/no `web` routes/);
  });

  it('does not mount the web app when bundle.web is present but web options are omitted (API-only)', async () => {
    const bundle: RatchetBundle = { ...emptyBundle, web: { routes: [], resourceRouteIds: new Set() } };
    const app = await createRatchetApp({ db, bundle });
    expect(await status(app, '/')).toBe(404);
    expect(await status(app, '/_ratchet/anything.js')).toBe(404);
  });
});
