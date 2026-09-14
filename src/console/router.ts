import { App, type Ctx } from '../router/http-app.js';
import type { AnyDb } from '../core/db.js';
import type { FileStorage } from '@flystorage/file-storage';
import type { ModelDefinition } from '../core/model.js';
import type { DomainDefinition } from '../core/domain.js';
import type { FileFieldDefinition } from '../core/field.js';
import { PipelineError } from '../core/pipeline.js';
import { getDomainSettings, updateDomainSettings } from '../core/domain-settings-persistence.js';
import { deriveDomainSettingsFileFields } from '../core/serialize.js';
import { generateId } from '../core/id.js';
import { DEFAULT_MAX_FILE_SIZE, matchesAccept, sniffMimeType, type StoredFile } from '../core/storage.js';
import { resolveSessionUser } from '../auth/pipeline.js';
import { toErrorResponse } from '../router/errors.js';
import { readJsonBody } from '../router/create-router.js';
import { serializeModelMeta } from './serialize-model.js';
import { serializeDomainSettingsMeta } from './serialize-domain.js';


/** Checks `def.settingFields` for a `kind: 'file'` entry — the Domain Settings counterpart of
 * `router/create-router.ts`'s `resolveFileField`, just without that one's extra fallback into a
 * custom operation's `params` (Domain Settings has no operations to search). */
function resolveDomainFileField(def: DomainDefinition, key: string): FileFieldDefinition {
  const f = def.settingFields?.[key];
  if (f?.kind === 'file') return f;
  throw new PipelineError({ code: 'NOT_FOUND', status: 404, message: `'${key}' is not a file setting on '${def.name}'` });
}

export interface ConsoleManifest {
  'main.js': string;
  'main.css'?: string;
}

export interface ConsoleAsset {
  body: BodyInit;
  contentType: string;
}

/** Lets `createConsoleRouter` serve the console SPA's shell and built assets without assuming a
 * local filesystem — Node's default (`ratchet/console/node`) reads `<generatedDir>/console` off
 * disk; an edge deploy supplies its own (a platform assets binding, KV/R2, bundled imports, ...). */
export interface ConsoleAssetSource {
  getManifest(): Promise<ConsoleManifest | null>;
  getAsset(assetPath: string): Promise<ConsoleAsset | null>;
}

/** `mountPath` is wherever the caller mounted this router (see e.g. src/cli/commands/serve.ts) —
 * absolute (`${mountPath}/...`), not relative (`./...`), asset URLs: a relative URL resolves
 * against the *current path*, so it broke on every route without a trailing slash once the SPA
 * got real sub-routes (`./assets/main.js` from a nested route resolves relative to that route,
 * not the shell's own path, 404ing every asset). */
// Applies the `.dark` class (see styles.css's `@custom-variant dark`, and `theme.ts`) before the
// stylesheet paints anything, so a returning visitor with dark mode chosen never sees a flash of
// the light theme first. Static — no request/user data ever goes into this string, so it's safe to
// inline verbatim; kept in sync with `theme.ts`'s `getInitialTheme` by hand (see that file's
// comment) since the two can't share source (this runs before the client bundle even loads).
const THEME_BOOTSTRAP_SCRIPT =
  '<script>' +
  '(function(){try{var t=localStorage.getItem("ratchet:theme");' +
  'if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}' +
  'if(t==="dark")document.documentElement.classList.add("dark")' +
  '}catch(e){}})()' +
  '</script>';

function renderShell(manifest: ConsoleManifest, mountPath: string): string {
  const prefix = mountPath === '/' ? '' : mountPath;
  const css = manifest['main.css'] ? `<link rel="stylesheet" href="${prefix}/${manifest['main.css']}">` : '';
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Ratchet console</title>',
    THEME_BOOTSTRAP_SCRIPT,
    css,
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script type="module" src="${prefix}/${manifest['main.js']}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function serveShell(assetSource: ConsoleAssetSource, mountPath: string) {
  return async (c: Ctx) => {
    const manifest = await assetSource.getManifest();
    if (!manifest) {
      return c.text(
        'console UI not built yet — run `ratchet build` or `ratchet dev` (requires a console/client/main.tsx entry)',
        503,
      );
    }
    return c.html(renderShell(manifest, mountPath));
  };
}

/** `app.route(mountPath, ...)` prefixes route *matching* but doesn't rewrite `c.req.path` — strip
 * the prefix ourselves so what we hand `assetSource` is the path relative to `${mountPath}/assets/`,
 * regardless of where this router got mounted. */
function assetPathFrom(c: Ctx, mountPath: string): string {
  const rest = mountPath === '/' ? c.req.path : c.req.path.slice(mountPath.length);
  return rest.replace(/^\/assets\//, '');
}

/** `${mountPath}/*` — serves the console UI shell + its built assets (resolved via `assetSource`,
 * see `ConsoleAssetSource` above), plus a small `/meta/models[/:name]` metadata API the console
 * SPA uses to render its sidebar and dynamically-generated CRUD views — driven by the same
 * registry map `createApiRouter` (src/router/create-router.ts) uses for `/api/:model`, so the two
 * never drift. Deliberately namespaced under `/meta` rather than `/api` so it never collides with
 * the top-level `/api` router even when `mountPath` is '/' (root mount). Mirrors
 * src/auth/router.ts's `createXRouter(...) -> App` shape.
 *
 * `mountPath` must match wherever the caller actually mounts the returned router — it's only used
 * to compute absolute asset URLs and strip the matched prefix back off `c.req.path`, since
 * `App.route()` (router/http-app.ts) doesn't rewrite `c.req.path` itself.
 *
 * `domainSettingsRegistry` (name -> DomainDefinition, default `{}`) backs the `/meta/domains*`
 * routes below the same way `registry` backs `/meta/models*` — optional, and defaulted, so an
 * existing caller that hasn't declared any Domains keeps compiling unchanged.
 *
 * `storage` (optional, like `createApiRouter`'s) backs the settings upload route below — only
 * needed once some Domain actually declares a `kind: 'file'` setting; omitted, that route 500s
 * the same way `createApiRouter`'s own upload route does with no storage configured. */
export function createConsoleRouter(
  assetSource: ConsoleAssetSource,
  registry: Record<string, ModelDefinition>,
  db: AnyDb,
  mountPath: string,
  domainSettingsRegistry: Record<string, DomainDefinition> = {},
  storage?: FileStorage,
): App {
  const app = new App();

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  app.get('/meta/models', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const models = Object.values(registry)
      .filter((model) => !model.console?.hidden)
      .map(serializeModelMeta);
    return c.json({ data: models });
  });

  app.get('/meta/models/:name', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const model = registry[c.req.param('name')];
    if (!model || model.console?.hidden) throw new PipelineError({ code: 'MODEL_NOT_FOUND', status: 404 });
    return c.json({ data: serializeModelMeta(model) });
  });

  // Every Domain with a declared `defineDomain()` — not every Domain a model happens to group
  // under (a Domain with no `defineDomain()` of its own, only models grouped under its folder,
  // has nothing to list here; the sidebar's per-Domain grouping reads `ConsoleModelMeta.domain`
  // instead, see `console/client/Layout.tsx`).
  app.get('/meta/domains', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const domains = Object.values(domainSettingsRegistry).map(serializeDomainSettingsMeta);
    return c.json({ data: domains });
  });

  app.get('/meta/domains/:name/settings', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const def = domainSettingsRegistry[c.req.param('name')];
    if (!def) throw new PipelineError({ code: 'DOMAIN_NOT_FOUND', status: 404 });
    const values = await getDomainSettings(db, def);
    return c.json({ data: deriveDomainSettingsFileFields(def, values) });
  });

  app.patch('/meta/domains/:name/settings', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const def = domainSettingsRegistry[c.req.param('name')];
    if (!def) throw new PipelineError({ code: 'DOMAIN_NOT_FOUND', status: 404 });
    const input = await readJsonBody(c);
    const values = await updateDomainSettings(db, def, input);
    return c.json({ data: deriveDomainSettingsFileFields(def, values) });
  });

  // `POST /meta/domains/:name/settings/:field/upload` — the Domain Settings counterpart of
  // `createApiRouter`'s `POST /:model/:field/upload` (same two-step upload flow: this stores the
  // blob and hands back a `StoredFile` reference, which the client then submits as the field's
  // normal value on the following `PATCH .../settings`). Unlike that route, this one *does*
  // require a session — every other `/meta/domains/*` route already does, and there's no
  // "new record, no permission context yet" excuse here the way there is for a model create form
  // (a Domain always has exactly one settings row, so there's always something to check auth
  // against). Whether the resulting value ever becomes publicly readable is a separate question,
  // decided per-field by `public` (`core/field.ts`) and enforced by `router/site-assets.ts` —
  // upload access and read access are independent here, same as they are for a model's `file` field.
  app.post('/meta/domains/:name/settings/:field/upload', async (c) => {
    await resolveSessionUser(db, c.req.raw);
    const def = domainSettingsRegistry[c.req.param('name')];
    if (!def) throw new PipelineError({ code: 'DOMAIN_NOT_FOUND', status: 404 });
    const field = resolveDomainFileField(def, c.req.param('field'));

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { file: 'required (multipart field "file")' } });
    }

    const maxSize = field.maxSize ?? DEFAULT_MAX_FILE_SIZE;
    if (file.size > maxSize) {
      throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { file: `exceeds ${maxSize} byte limit` } });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffMimeType(bytes, file.type);
    if (field.accept && !matchesAccept(mimeType, field.accept)) {
      throw new PipelineError({
        code: 'VALIDATION_ERROR',
        status: 400,
        fields: { file: `must match '${field.accept}' (detected '${mimeType}')` },
      });
    }

    if (!storage) {
      throw new PipelineError({ code: 'INTERNAL', status: 500, message: 'this app has a Domain Settings `file` field but no FileStorage was passed to createConsoleRouter' });
    }
    const key = `domain-settings/${def.name}/${c.req.param('field')}/${generateId()}`;
    // see `router/create-router.ts`'s own upload route for why this is `Buffer.from(bytes)`, not
    // `bytes` itself — a plain `Uint8Array` gets silently corrupted by flystorage's stream conversion.
    await storage.write(key, Buffer.from(bytes), { mimeType });

    const stored: StoredFile = { key, filename: file.name, mimeType, size: bytes.byteLength };
    return c.json({ data: stored }, 201);
  });

  app.get('/assets/*', async (c) => {
    const asset = await assetSource.getAsset(assetPathFrom(c, mountPath));
    if (!asset) return c.notFound();
    return new Response(asset.body, { headers: { 'content-type': asset.contentType } });
  });

  // catch-all, not just `/`: the SPA uses react-router's BrowserRouter (client-side, path-based
  // routes like `${mountPath}/customers/:id`), so a hard refresh/deep link on any of those paths
  // must still resolve to the same shell — routing itself happens in the browser after it loads.
  app.get('/*', serveShell(assetSource, mountPath));

  return app;
}
