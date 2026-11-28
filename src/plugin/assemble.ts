import type { AnyDb } from '../core/db.js';
import type { ModelDefinition } from '../core/model.js';
import type { DomainDefinition } from '../core/domain.js';
import { PLUGIN_API_VERSION, type PluginContext, type PluginRoute, type PluginSetupInfo, type RatchetPlugin } from './types.js';
import { pluginToolkit } from './toolkit.js';

/** Prefixes core itself owns under `/api` — a plugin can't claim them. */
const RESERVED_PREFIXES = ['/api/auth'];

/**
 * Static checks that need no DB: unique names, matching `apiVersion`, `requires` satisfied,
 * `module` present whenever models/domains are. Shared by `ratchet generate` (fail before writing
 * anything) and `createRatchetApp` (fail at boot).
 */
export function assertValidPlugins(plugins: readonly RatchetPlugin[]): void {
  const names = new Set<string>();
  for (const p of plugins) {
    if (!p || typeof p.name !== 'string' || !p.name) {
      throw new Error('ratchet.config.ts: every entry in `plugins` must be a plugin object with a `name`');
    }
    if (names.has(p.name)) throw new Error(`plugin '${p.name}' is listed twice in \`plugins\``);
    names.add(p.name);
    if (p.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(
        `plugin '${p.name}' targets plugin API v${String(p.apiVersion)}, but this @egig/ratchet implements v${PLUGIN_API_VERSION} — upgrade whichever side is older`,
      );
    }
    const hasExports = Object.keys(p.models ?? {}).length > 0 || Object.keys(p.domains ?? {}).length > 0;
    if (hasExports && !p.module) {
      throw new Error(`plugin '${p.name}' declares models/domains but no \`module\` specifier to import them from`);
    }
  }
  for (const p of plugins) {
    for (const dep of p.requires ?? []) {
      if (!names.has(dep)) throw new Error(`plugin '${p.name}' requires plugin '${dep}', which is not in \`plugins\``);
    }
  }
}

function assertValidPrefixes(routes: Array<PluginRoute & { plugin: string }>, models: Record<string, ModelDefinition>): void {
  const seen = new Map<string, string>();
  for (const { prefix, plugin } of routes) {
    if (!/^\/api\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(prefix)) {
      throw new Error(`plugin '${plugin}': route prefix '${prefix}' must look like '/api/<segment>' (no trailing slash)`);
    }
    if (RESERVED_PREFIXES.some((r) => prefix === r || prefix.startsWith(`${r}/`))) {
      throw new Error(`plugin '${plugin}': route prefix '${prefix}' is reserved by @egig/ratchet`);
    }
    const segment = prefix.split('/')[2]!;
    // an `api.hidden` model has no generic routes (create-router 404s it), so there's nothing to
    // shadow — that's how a plugin serves its own model through a dedicated router
    // (e.g. automation's `workflows` model behind `/api/workflows`)
    if (models[segment] && !models[segment]!.api?.hidden) {
      throw new Error(
        `plugin '${plugin}': route prefix '${prefix}' would shadow the generic '/api/${segment}' routes of model '${segment}' — rename the model or the prefix`,
      );
    }
    const other = seen.get(prefix);
    if (other) throw new Error(`plugins '${other}' and '${plugin}' both mount '${prefix}'`);
    seen.set(prefix, plugin);
  }
}

export interface PluginRuntime {
  /** the DB handle after every `decorateDb` — use it for every router */
  db: AnyDb;
  ctx: PluginContext;
  routes: PluginRoute[];
  /** runs every plugin's `onSetup`, in plugin order, inside the caller's transaction */
  runSetup: (info: PluginSetupInfo) => Promise<void>;
}

export async function assemblePlugins(opts: {
  plugins: readonly RatchetPlugin[];
  db: AnyDb;
  models: Record<string, ModelDefinition>;
  domains: Record<string, DomainDefinition>;
  env: 'development' | 'production';
}): Promise<PluginRuntime> {
  const { plugins } = opts;
  assertValidPlugins(plugins);

  const ctx: PluginContext = {
    db: opts.db,
    models: opts.models,
    domains: opts.domains,
    env: opts.env,
    plugins: {},
    kit: pluginToolkit,
  };

  for (const p of plugins) {
    if (p.decorateDb) ctx.db = p.decorateDb(ctx.db, ctx);
  }
  for (const p of plugins) {
    if (p.service) ctx.plugins[p.name] = p.service(ctx);
  }

  const tagged: Array<PluginRoute & { plugin: string }> = [];
  for (const p of plugins) {
    for (const route of (await p.routes?.(ctx)) ?? []) tagged.push({ ...route, plugin: p.name });
  }
  assertValidPrefixes(tagged, opts.models);

  return {
    db: ctx.db,
    ctx,
    routes: tagged.map(({ prefix, app }) => ({ prefix, app })),
    runSetup: async (info) => {
      for (const p of plugins) await p.onSetup?.(info, ctx);
    },
  };
}
