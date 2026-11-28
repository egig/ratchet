import type { AnyDb } from '../core/db.js';
import type { ModelDefinition } from '../core/model.js';
import type { DomainDefinition } from '../core/domain.js';
import type { App } from '../router/http-app.js';
import type { PluginToolkit } from './toolkit.js';

/**
 * The plugin contract version this build of `@egig/ratchet` implements. A plugin declares the
 * version it was written against (`RatchetPlugin.apiVersion`); `createRatchetApp` and
 * `ratchet generate` refuse to load a plugin whose version doesn't match, so an incompatible
 * plugin fails at boot with a clear message instead of crashing on a missing context member.
 */
// v2: console modules navigate with the router exported by `@egig/ratchet/console/client`;
// the console no longer runs on react-router.
export const PLUGIN_API_VERSION = 2;

/** A router a plugin mounts. `prefix` must start with `/api/` and must not collide with any
 * model's `/api/:model` segment or another plugin's prefix (checked at boot). Mounted after
 * `/api/auth` and before the generic `/api/:model` router, in plugin array order. */
export interface PluginRoute {
  prefix: string;
  app: App;
}

/** What `onSetup` receives — the first-admin bootstrap (`POST /api/auth/setup`,
 * `ratchet create-admin`) runs every plugin's hook inside its own transaction, after the Root
 * role and the first user exist. */
export interface PluginSetupInfo {
  /** the transaction handle — write through this, never the outer `ctx.db` */
  tx: AnyDb;
  rootRoleId: string;
  userId: string;
}

/** A console form a plugin contributes for one of its own models — the plugin-side equivalent of
 * a consumer's `<model>.form.tsx`. `module` is a bare specifier the console bundle can import
 * (typically the plugin's own `./console` export); `exportName` is the component's named export. */
export interface PluginForm {
  modelName: string;
  module: string;
  exportName: string;
}

/**
 * A Ratchet plugin — a self-contained feature package (models, routers, console UI) a consumer
 * enables by listing it in `ratchet.config.ts`'s `plugins: [...]`. Usually returned by a factory
 * (`automation({ ... })`) so options travel with it.
 *
 * Plugin objects carry functions, so the config module itself is bundled into every server entry
 * (`.ratchet/app.ts` imports it) — read secrets from `process.env` at call time, same rule as
 * `FrameworkConfig.auth`.
 */
export interface RatchetPlugin {
  /** unique across the app; also the key other plugins see this one's `service` under */
  name: string;
  /** must equal `PLUGIN_API_VERSION` */
  apiVersion: number;
  /**
   * Bare import specifier the generated `.ratchet/*` files import this plugin's `models` and
   * `domains` from, by their keys below (e.g. `'@egig/ratchet-automation'` exporting `Agent`).
   * Required when `models` or `domains` is non-empty.
   */
  module?: string;
  /** exportName → model. Joined into the same model graph as the consumer's own `models/**` */
  models?: Record<string, ModelDefinition>;
  /** the Domain every model above belongs to (ADR 0001 — a plugin has no folder to infer it from) */
  domain?: string;
  /** exportName → Domain definition */
  domains?: Record<string, DomainDefinition>;
  forms?: PluginForm[];
  /** plugins that must be present (boot fails otherwise) */
  requires?: string[];
  /** plugins used when present — read them via `ctx.plugins[name]`, which may be `undefined` */
  optional?: string[];
  /** a value other plugins can reach as `ctx.plugins[this.name]` */
  service?: (ctx: PluginContext) => unknown;
  /** wrap the app's DB handle (e.g. to observe mutations). Applied in plugin order, before any
   * router is built, so every router — the generic one included — sees the decorated handle. */
  decorateDb?: (db: AnyDb, ctx: PluginContext) => AnyDb;
  routes?: (ctx: PluginContext) => PluginRoute[] | Promise<PluginRoute[]>;
  onSetup?: (info: PluginSetupInfo, ctx: PluginContext) => Promise<void>;
  /** bare specifier(s) of browser modules whose default export is a `ConsolePlugin`
   * (`@egig/ratchet/console/client`). Bundled into the console via `ratchet:plugins`. A list lets
   * a plugin ship only the UI its enabled features need. */
  console?: string | string[];
  /** Tailwind inputs for the console build: `source` is an absolute directory scanned for class
   * names (plugin `.tsx` lives in `node_modules`, which the default scan skips); `css` is an
   * absolute path to an extra stylesheet `@import`ed into the console's CSS entry. */
  consoleStyles?: { source?: string; css?: string[] };
}

/**
 * Everything a plugin is handed at runtime. Core internals stay private: what a plugin may call
 * is exactly this object (plus the public `@egig/ratchet/core|router|auth` exports), versioned by
 * `PLUGIN_API_VERSION`.
 */
export interface PluginContext {
  /** the app's DB handle, already decorated by every plugin's `decorateDb` */
  db: AnyDb;
  models: Record<string, ModelDefinition>;
  domains: Record<string, DomainDefinition>;
  env: 'development' | 'production';
  /** other plugins' services, by plugin name (only those that declare `service`) */
  plugins: Record<string, unknown>;
  /** persistence, access control, HTTP and serialization helpers — see `PluginToolkit` */
  kit: PluginToolkit;
}

export function definePlugin<T extends RatchetPlugin>(plugin: T): T {
  return plugin;
}
