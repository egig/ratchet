import type { AnyDb } from '../core/db.js';
import type { RouteObject } from 'react-router';
import { App } from '../router/http-app.js';
import { createApiRouter } from '../router/create-router.js';
import { createSiteAssetsRouter } from '../router/site-assets.js';
import { createAuthRouter } from '../auth/router.js';
import type { AuthConfig } from '../auth/better-auth.js';
import { assertValidConsolePath } from './console-path.js';
import { assemblePlugins } from '../plugin/assemble.js';
import type { RatchetPlugin } from '../plugin/types.js';
import { workspacePlugin } from '../workspace/plugin.js';
import type { ModelDefinition } from '../core/model.js';
import type { DomainDefinition } from '../core/domain.js';
import type { FileStorage } from '../core/storage.js';
import type { ConsoleAssetSource } from '../console/router.js';


/**
 * The generated model/domain bundle — `.ratchet/app.ts` (written by `ratchet generate`) exports one
 * of these as `bundle`. `models` and `domains` stay separate maps (different keyspaces, different
 * value types); they're carried together only so an entry file passes one thing, not four.
 */
export interface RatchetBundle {
  models: Record<string, ModelDefinition>;
  domains: Record<string, DomainDefinition>;
  /** present only when the consumer opted into the `src/web/` site (`routes/root.tsx` exists) */
  web?: { routes: RouteObject[]; resourceRouteIds?: ReadonlySet<string> };
  /** `ratchet.config.ts`'s `plugins` — `.ratchet/app.ts` imports the config module to carry them */
  plugins?: RatchetPlugin[];
}

/** Plugins every app gets regardless of config, ahead of the consumer's own. */
export const BUILTIN_PLUGINS: RatchetPlugin[] = [workspacePlugin];

export interface RatchetAppOptions {
  /** drizzle-postgres client (already constructed — `createRatchetApp` never reads config) */
  db: AnyDb;
  bundle: RatchetBundle;
  /** omit → `field.file` writes fail with 500, same as today */
  storage?: FileStorage;
  /**
   * where the console router reads its built JS/CSS from. Omit → the console is not mounted at all
   * (e.g. Vercel, which serves those assets straight off its CDN). Infra, not a feature toggle.
   */
  consoleAssets?: ConsoleAssetSource;
  /** default `/console`; validated (see `assertValidConsolePath`) when `consoleAssets` is set */
  consolePath?: string;
  /**
   * runtime paths the web bundle can't carry — required exactly when `bundle.web` is present.
   * `generatedDir` locates `<generatedDir>/web/assets` for the `/_ratchet/*` mount; `entrySrc` is
   * the hashed `<script src>` for the client entry; `publicDir` is served at `/` before SSR.
   */
  web?: { entrySrc: string; publicDir?: string; generatedDir: string };
  /** default `'development'`. In `'production'`, `/api/auth/setup` 404s unconditionally instead
   * of exposing whether a root admin exists — see `resolveEnv` (`core/config.ts`). */
  env?: 'development' | 'production';
  /** better-auth options (`FrameworkConfig.auth`): social providers, email callbacks, plugins, the
   * secret/baseURL — see `AuthConfig` (src/auth/better-auth.ts). */
  auth?: AuthConfig;
}

/**
 * Assemble the one `App` every ratchet entry point serves — `ratchet serve`, the bundled
 * `dist/server.js`, a Cloudflare Worker, a Vercel function. Owns the registration-order-sensitive
 * mount sequence (most specific prefix first) so it lives in exactly one place:
 *
 *   /api/auth  →  (plugin prefixes)  →  /api  →  (console)  →  /_site-assets  →  (/_ratchet + web /)
 *
 * Core features (`/api/auth`, `/api`, `/_site-assets`) are always mounted; plugin routers
 * (`bundle.plugins`) mount between `/api/auth` and the generic `/api/:model`. Infrastructure is
 * configurable: the console mounts iff `consoleAssets` is supplied, the web app iff `bundle.web`
 * is present. Pure assembly — no config loading, no `import()` of generated files —
 * so it runs unchanged inside a Worker's `fetch(request, env)` handler. The caller listens
 * (`Bun.serve` / `serveNode` / `export default`) and logs.
 */
export async function createRatchetApp(opts: RatchetAppOptions): Promise<App> {
  const { bundle, storage } = opts;
  const { models, domains } = bundle;
  const env = opts.env ?? 'development';

  // Plugins first: `decorateDb` may wrap the handle (e.g. workflow triggers observing every
  // mutation), and every router below must be built over the decorated one.
  const plugins = await assemblePlugins({
    plugins: [...BUILTIN_PLUGINS, ...(bundle.plugins ?? [])],
    db: opts.db,
    models,
    domains,
    env,
  });
  const db = plugins.db;

  const app = new App();
  // Route matching is a linear scan, first structural match wins (router/http-app.ts), so the
  // order here IS the precedence. Fixed-prefix routers first; the console (whose `consolePath`
  // can be '/', making its `/*` a total catch-all) after them; the web app's own `/` catch-all
  // dead last.
  //
  //   /api/auth                     — must win over the generic `/api/:model` pattern
  //   plugin prefixes (/api/<x>)    — same; collisions with model names are rejected at boot
  //   /api                          — the generic model router
  //   /_site-assets                 — public file-field values; fixed prefix, mounted before the
  //                                   console so a `consolePath: '/'` can't shadow it
  //   consolePath                   — the admin SPA
  //   /_ratchet · /                 — the web app (catch-all), only when opts.web is supplied
  app.route('/api/auth', createAuthRouter(db, { env, config: opts.auth, onSetup: plugins.runSetup }));
  for (const { prefix, app: pluginApp } of plugins.routes) app.route(prefix, pluginApp);
  app.route('/api', createApiRouter(models, db, storage));
  app.route('/_site-assets', createSiteAssetsRouter(db, storage, domains));

  if (opts.consoleAssets) {
    const consolePath = opts.consolePath ?? '/console';
    assertValidConsolePath(consolePath);
    // lazy — keeps the console client bits out of a Vercel/Worker graph that never mounts them
    const { createConsoleRouter } = await import('../console/router.js');
    app.route(consolePath, createConsoleRouter(opts.consoleAssets, models, db, consolePath, domains, storage));
  }

  // The web app mounts when the caller supplies its runtime paths (`opts.web`). A caller that
  // omits them — e.g. a Vercel function that only fields `/api/*`, with the site deployed
  // separately — just doesn't get the `/` + `/_ratchet` mounts. But asking to mount a site the
  // codegen step never produced (`opts.web` set, `bundle.web` absent) is a misconfiguration.
  if (opts.web) {
    if (!bundle.web) {
      throw new Error(
        'createRatchetApp was given `web` options, but the bundle has no `web` routes — run `ratchet generate` with a `routes/root.tsx`',
      );
    }
    // lazy — keeps React Router out of a graph that never mounts the site
    const { createWebRouter, createWebAssetsRouter } = await import('../web/router.js');
    app.route('/_ratchet', createWebAssetsRouter(opts.web.generatedDir));
    app.route(
      '/',
      createWebRouter({
        routes: bundle.web.routes,
        resourceRouteIds: bundle.web.resourceRouteIds,
        entrySrc: opts.web.entrySrc,
        publicDir: opts.web.publicDir,
        db,
        registry: models,
        domainSettingsRegistry: domains,
        storage,
      }),
    );
  }

  return app;
}

export { assertValidConsolePath } from './console-path.js';
