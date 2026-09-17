import type { AnyDb } from '../core/db.js';
import type { RouteObject } from 'react-router';
import { App } from '../router/http-app.js';
import { createApiRouter } from '../router/create-router.js';
import { createSiteAssetsRouter } from '../router/site-assets.js';
import { createAuthRouter } from '../auth/router.js';
import { createAutomationRouter } from '../automation/router.js';
import { assertValidConsolePath } from './console-path.js';
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
}

export interface RatchetAppOptions {
  /** drizzle-postgres client (already constructed — `createRatchetApp` never reads config) */
  db: AnyDb;
  workflows?: import('../workflows/config.js').WorkflowConfig;
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
}

/**
 * Assemble the one `App` every ratchet entry point serves — `ratchet serve`, the bundled
 * `dist/server.js`, a Cloudflare Worker, a Vercel function. Owns the registration-order-sensitive
 * mount sequence (most specific prefix first) so it lives in exactly one place:
 *
 *   /api/auth  →  /api/automation  →  /api  →  (console)  →  /_site-assets  →  (/_ratchet + web /)
 *
 * Features (`/api/auth`, `/api/automation`, `/api`, `/_site-assets`) are always mounted. Only
 * infrastructure is configurable: the console mounts iff `consoleAssets` is supplied, the web app
 * iff `bundle.web` is present. Pure assembly — no config loading, no `import()` of generated files —
 * so it runs unchanged inside a Worker's `fetch(request, env)` handler. The caller listens
 * (`Bun.serve` / `serveNode` / `export default`) and logs.
 */
export async function createRatchetApp(opts: RatchetAppOptions): Promise<App> {
  const { bundle, storage } = opts;
  let db = opts.db;
  const { models, domains } = bundle;

  const app = new App();
  if (opts.workflows) {
    const { WorkflowRuntime } = await import('../workflows/runtime.js');
    const { createInngestAdapter } = await import('../workflows/inngest.js');
    const { createWorkflowRouter } = await import('../workflows/router.js');
    const runtime = new WorkflowRuntime(db, models, opts.workflows);
    runtime.adapter = createInngestAdapter(runtime);
    db = runtime.observe();
    app.route('/api/workflows', createWorkflowRouter(runtime));
  }
  // Route matching is a linear scan, first structural match wins (router/http-app.ts), so the
  // order here IS the precedence. Fixed-prefix routers first; the console (whose `consolePath`
  // can be '/', making its `/*` a total catch-all) after them; the web app's own `/` catch-all
  // dead last.
  //
  //   /api/auth · /api/automation   — must win over the generic `/api/:model` pattern
  //   /api                          — the generic model router
  //   /_site-assets                 — public file-field values; fixed prefix, mounted before the
  //                                   console so a `consolePath: '/'` can't shadow it
  //   consolePath                   — the admin SPA
  //   /_ratchet · /                 — the web app (catch-all), only when opts.web is supplied
  app.route('/api/auth', createAuthRouter(db, { env: opts.env ?? 'development' }));
  app.route('/api/automation', createAutomationRouter(db, models));
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
