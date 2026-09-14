import { App } from './http-app.js';
import type { AnyDb } from '../core/db.js';
import type { FileStorage } from '@flystorage/file-storage';
import type { DomainDefinition } from '../core/domain.js';
import { PipelineError } from '../core/pipeline.js';
import { getDomainSettings } from '../core/domain-settings-persistence.js';
import { streamStoredFile } from '../core/file-serving.js';
import type { StoredFile } from '../core/storage.js';
import { toErrorResponse } from './errors.js';


/**
 * Serves a `field.file({ public: true })` Domain Settings value with no auth at all — the read
 * side of that flag (`core/field.ts`), mirroring `core/serialize.ts`'s `siteAssetUrl`, the URL
 * this route must match: `GET /_site-assets/:domain/:field/:token`. Deliberately its own tiny
 * router, not folded into `console/router.ts` (which owns writing Domain Settings, behind a
 * session) or the web app's routes — a public site asset's URL
 * shouldn't move if `consolePath` is ever reconfigured, and this stays domain-agnostic so a
 * second Domain adding its own `public: true` file field needs no new router, just a registry
 * entry (see `cli/commands/serve.ts`, mounted at the fixed `/_site-assets` prefix).
 *
 * `:token` is checked for existence only, never matched against the stored key — it exists purely
 * to give the URL a distinct identity per upload (see `streamStoredFile`'s doc comment on why that
 * makes a long, immutable cache lifetime safe here even though the analogous model-file route
 * doesn't set one).
 */
export function createSiteAssetsRouter(
  db: AnyDb,
  storage: FileStorage | undefined,
  domainSettingsRegistry: Record<string, DomainDefinition>,
): App {
  const app = new App();

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  app.get('/:domain/:field/:token', async (c) => {
    const def = domainSettingsRegistry[c.req.param('domain')];
    const field = def?.settingFields?.[c.req.param('field')];
    if (!field || field.kind !== 'file' || !field.public) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    if (!storage) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });

    const values = await getDomainSettings(db, def);
    const stored = values[c.req.param('field')] as StoredFile | undefined;
    if (!stored) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });

    return streamStoredFile(
      storage,
      stored,
      `GET /_site-assets/${c.req.param('domain')}/${c.req.param('field')}/${c.req.param('token')}`,
      'public, max-age=31536000, immutable',
    );
  });

  return app;
}
