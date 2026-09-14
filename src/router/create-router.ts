import { App, type Ctx } from './http-app.js';
import type { AnyDb } from '../core/db.js';
import type { FileStorage } from '@flystorage/file-storage';
import type { FileFieldDefinition } from '../core/field.js';
import type { CustomOperationDefinition, ModelDefinition } from '../core/model.js';
import type { OperationContext } from '../core/pipeline.js';
import { PipelineError } from '../core/pipeline.js';
import { generateId } from '../core/id.js';
import { fetchRow } from '../core/persistence.js';
import { deriveFileFields, redactSensitiveFields } from '../core/serialize.js';
import { buildParamsSchema } from '../core/validation.js';
import { DEFAULT_MAX_FILE_SIZE, matchesAccept, sniffMimeType, type StoredFile } from '../core/storage.js';
import { streamStoredFile } from '../core/file-serving.js';
import {
  authorizeRequest,
  resolveGrantedFields,
  pickGrantedFields,
  assertWriteFieldsAllowed,
  type GrantedFields,
} from '../auth/pipeline.js';
import type { UserRow } from '../auth/lookup.js';
import { toErrorResponse } from './errors.js';
import { parseInclude, parseListQuery } from './query.js';
import { getOneRow, listRows } from './list.js';
import { assertReadFieldsAllowed, filterIncludedRelations } from './read-access.js';

type AccessResult = { user: UserRow | null };
type FieldAccessResult = { user: UserRow | null; granted: GrantedFields };

/** `OperationContext.user` is a plain `Record<string, unknown>` (no index signature on `UserRow`
 * itself), so setting it from a resolved `UserRow` needs the same double-cast `requireAuth`
 * (auth/pipeline.ts) already used before this router started resolving the user itself. */
function toCtxUser(user: UserRow | null): Record<string, unknown> | null {
  return user as unknown as Record<string, unknown> | null;
}

/** Every route on the generic router requires a matching role grant by default — including
 * reads (the implicit `'read'` action, see `ratchet/auth`'s `Role.permissions`) — with
 * no way to opt individual models back in to their old always-open behavior except `api.public`
 * (`core/model.ts`). Skips auth entirely for a `public` model; otherwise defers to
 * `authorizeRequest`, which 401s (no/expired session) or 403s (session valid, permission missing). */
async function resolveAccess(db: AnyDb, request: Request | undefined, model: ModelDefinition, action: string): Promise<AccessResult> {
  if (model.api?.public) return { user: null };
  const user = await authorizeRequest(db, request, model.name, action);
  return { user };
}

/** `resolveAccess` plus the field-level grant for a field-shaped action (`read`/`create`/
 * `update` — never `remove`, which has no field concept, see
 * `FIELDLESS_ACTIONS`). A `public` model gets `'*'` — no session means no role to scope fields by,
 * and "public but field-restricted" isn't a combination this framework supports. */
async function resolveFieldAccess(
  db: AnyDb,
  request: Request | undefined,
  model: ModelDefinition,
  action: string,
): Promise<FieldAccessResult> {
  if (model.api?.public) return { user: null, granted: '*' };
  const user = await authorizeRequest(db, request, model.name, action);
  const granted = await resolveGrantedFields(db, user.roleId, model.name, action);
  return { user, granted };
}


function resolveModel(registry: Record<string, ModelDefinition>, name: string): ModelDefinition {
  const model = registry[name];
  // a model with `api.hidden` (e.g. Chat/Message, src/automation/models) 404s exactly like an
  // unknown name — this router has no per-row ownership check, so it must not be reachable at
  // all for a model whose only legitimate access path is a dedicated, auth-scoped router.
  if (!model || model.api?.hidden) throw new PipelineError({ code: 'MODEL_NOT_FOUND', status: 404 });
  return model;
}

/** `ApiModelOptions.ownerField` (core/model.ts) gate for a single already-fetched row — 404s
 * rather than 403ing on a mismatch, same "don't reveal existence" behavior as the write-side
 * `requireOwnsRow` (core/pipeline.ts) this pairs with. */
function assertOwnsRow(model: ModelDefinition, row: Record<string, unknown>, userId: string): void {
  if (model.api?.ownerField && row[model.api.ownerField] !== userId) {
    throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  }
}

/** Checks `model.fields` first, then falls back to every custom operation's `params` (Q16: a
 * `file`-kind operation param, e.g. an "attach" operation's `attachment` param, isn't a real model
 * column — it only exists in `CustomOperationDefinition.params` — so it wouldn't otherwise be
 * reachable through this same two-step upload flow the console's `FieldInput` always uses for a
 * `kind: 'file'` value, model field or operation param alike). */
function resolveFileField(model: ModelDefinition, key: string): FileFieldDefinition {
  const direct = model.fields[key];
  if (direct?.kind === 'file') return direct;
  for (const entry of Object.values(model.operations)) {
    const f = (typeof entry === 'function' ? undefined : entry.params?.[key]);
    if (f?.kind === 'file') return f;
  }
  throw new PipelineError({ code: 'NOT_FOUND', status: 404, message: `'${key}' is not a file field on '${model.name}'` });
}

/** Applies `redactSensitiveFields` + `deriveFileFields` to every row on its way out — the one
 * place a raw persisted row becomes an HTTP-safe one (Q12: a `file` field's storage `key` must
 * never reach a client). */
function toResponseRow(model: ModelDefinition, row: Record<string, unknown>): Record<string, unknown> {
  return deriveFileFields(model, redactSensitiveFields(model, row));
}

export async function readJsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('not an object');
    }
    return body as Record<string, unknown>;
  } catch {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { body: 'must be a JSON object' } });
  }
}

function fileFieldsOf(model: ModelDefinition): [string, FileFieldDefinition][] {
  return Object.entries(model.fields).filter((e): e is [string, FileFieldDefinition] => e[1].kind === 'file');
}

function storedFileOf(row: Record<string, unknown> | null, key: string): StoredFile | undefined {
  const value = row?.[key];
  return value && typeof value === 'object' ? (value as StoredFile) : undefined;
}

/** Q10: eager, best-effort cleanup — once `newDoc` (already committed) no longer references a
 * `file` field's old blob, the old blob is deleted from storage. Deliberately does *not* run on
 * remove: `persist.remove` is a soft delete (the row, and its file references, still exist —
 * matching how a soft-deleted row also still holds its unique-constrained values, see
 * schema-gen.ts), so there's nothing orphaned yet. A delete failure is logged, not thrown — the
 * record write already committed and must not be rolled back over a storage-side cleanup issue. */
async function cleanupReplacedFiles(
  storage: FileStorage | undefined,
  model: ModelDefinition,
  oldDoc: Record<string, unknown> | null,
  newDoc: Record<string, unknown>,
): Promise<void> {
  if (!storage || !oldDoc) return;
  for (const [key] of fileFieldsOf(model)) {
    const oldFile = storedFileOf(oldDoc, key);
    const newFile = storedFileOf(newDoc, key);
    if (oldFile && oldFile.key !== newFile?.key) {
      try {
        await storage.deleteFile(oldFile.key);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`cleanupReplacedFiles: failed to delete '${oldFile.key}' (model '${model.name}', field '${key}')`, err);
      }
    }
  }
}

function requireStorage(storage: FileStorage | undefined): FileStorage {
  if (!storage) {
    throw new PipelineError({
      code: 'INTERNAL',
      status: 500,
      message: 'this app has a `file` field but no FileStorage was passed to createApiRouter',
    });
  }
  return storage;
}


/**
 * §5 pivot: one generic handler serves every model, dispatching by looking up `:model` in the
 * registry at request time — no per-model generated route files.
 *
 * `storage` is only required if some model in `registry` has a `file` field — a flystorage
 * `FileStorage` (core/storage.ts), built by one of the `ratchet/storage/*` factories or
 * `buildStorageAdapter` (`ratchet/storage`). Constructor-injected the same way `createConsoleRouter`
 * takes a `ConsoleAssetSource`: a storage backend isn't always resolvable from a plain config
 * value (e.g. Cloudflare R2 is an `env`-injected binding), so the app's own entry file builds and
 * passes in whichever adapter fits its deploy target.
 */
export function createApiRouter(registry: Record<string, ModelDefinition>, db: AnyDb, storage?: FileStorage): App {
  const app = new App();

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status);
  });

  app.get('/:model', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const { user, granted } = await resolveFieldAccess(db, c.req.raw, model, 'read');
    const query = parseListQuery(model, new URL(c.req.url).searchParams, registry);
    assertReadFieldsAllowed(model, query, granted);
    if (model.api?.ownerField) {
      if (!user) throw new PipelineError({ code: 'INTERNAL', status: 500, message: `'${model.name}' combines api.ownerField with api.public — unsupported` });
      query.filters.push({ field: model.api.ownerField, op: '=', value: user.id });
    }
    const page = await listRows(db, model, registry, query);
    for (const row of page.rows) {
      await filterIncludedRelations(db, registry, model, row, query.include, user?.roleId);
    }
    const rows = page.rows.map((row) => pickGrantedFields(model, row, granted));

    // §5: `{ data, meta }` always — offset mode gets total/limit/offset, cursor mode gets nextCursor/hasMore.
    if (page.mode === 'offset') {
      return c.json({ data: rows, meta: { total: page.total, limit: page.limit, offset: page.offset } });
    }
    return c.json({ data: rows, meta: { nextCursor: page.nextCursor, hasMore: page.hasMore } });
  });

  app.get('/:model/:id', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const { user, granted } = await resolveFieldAccess(db, c.req.raw, model, 'read');
    const searchParams = new URL(c.req.url).searchParams;
    const include = parseInclude(model, searchParams.get('include'), registry);
    const row = await getOneRow(db, model, registry, c.req.param('id'), {
      includeDeleted: searchParams.get('includeDeleted') === 'true',
      include,
    });
    if (!row) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    if (model.api?.ownerField) {
      if (!user) throw new PipelineError({ code: 'INTERNAL', status: 500, message: `'${model.name}' combines api.ownerField with api.public — unsupported` });
      assertOwnsRow(model, row, user.id);
    }
    await filterIncludedRelations(db, registry, model, row, include, user?.roleId);
    return c.json({ data: pickGrantedFields(model, row, granted) });
  });

  // `GET /:model/:id/:field` — the only way a client ever reads a `file` field's bytes back
  // (Q9/Q12: the record's own JSON response only ever carries this route's URL, never the raw
  // storage key). Uses `fetchRow`, not `getOneRow` — `getOneRow` (router/list.ts) already runs
  // every row through `deriveFileFields` on its way out (so `?include=`d/listed rows are always
  // response-shaped), which would strip the very storage `key` this route needs to read the
  // blob back; `fetchRow` returns the row as persisted, same soft-delete exclusion by default.
  // Gated by the same `read` field grant as the record's own JSON response — a role that can't
  // see a `file` field's metadata can't fetch its bytes either.
  app.get('/:model/:id/:field', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    resolveFileField(model, c.req.param('field'));
    const { user, granted } = await resolveFieldAccess(db, c.req.raw, model, 'read');
    if (granted !== '*' && !granted.has(c.req.param('field'))) {
      throw new PipelineError({ code: 'FORBIDDEN', status: 403, message: `missing read permission for field '${c.req.param('field')}'` });
    }
    const row = await fetchRow(db, model, c.req.param('id'));
    if (!row) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
    if (model.api?.ownerField) {
      if (!user) throw new PipelineError({ code: 'INTERNAL', status: 500, message: `'${model.name}' combines api.ownerField with api.public — unsupported` });
      assertOwnsRow(model, row, user.id);
    }
    const stored = storedFileOf(row, c.req.param('field'));
    if (!stored) throw new PipelineError({ code: 'NOT_FOUND', status: 404 });

    // Streamed straight from the storage backend rather than buffered — the DB row already
    // carries `stored.mimeType`, so there's no need to wait on flystorage's own stat/mimeType
    // detection first. A missing blob (e.g. deleted out from under a row that still references
    // it) surfaces as `UnableToReadFile` here, before any bytes are sent, so it still 404s
    // cleanly; an error once streaming has actually started (rarer — the backend itself failing
    // mid-read) just ends the connection, the same way any streamed HTTP response would. Any
    // `UnableToReadFile` here maps to 404, not just one whose `wasFileNotFound` flag is set —
    // adapters aren't consistent about setting it (flystorage's own `@flystorage/in-memory`
    // throws a plain `Error` for a missing key, which `FileStorage.read()` still wraps as
    // `UnableToReadFile` but leaves `wasFileNotFound: false`) — logged so an operator can still
    // tell a real backend fault from an ordinary missing-blob 404. No `cacheControl`: this URL
    // stays the same across a file being replaced (it's keyed by row `id`, not by the storage
    // key), so caching it would risk serving stale bytes — see `streamStoredFile`'s doc comment.
    return streamStoredFile(requireStorage(storage), stored, `GET /${model.name}/${c.req.param('id')}/${c.req.param('field')}`);
  });

  // `POST /:model/:field/upload` — the two-step upload flow (Q3): this stores the blob and hands
  // back a `StoredFile` reference; the client then sends that reference as the field's normal
  // create/update value. No id — a "new record" form uploads before the record exists.
  //
  // Deliberately unauthenticated, unlike every other route in this router (which now implicitly
  // requires auth+permission by default — see `resolveAccess`/`resolveFieldAccess`). This route
  // isn't tied to any one operation (a "new record" form uploads before the record exists, so
  // there's no `create`/`update` action to check permission against yet) and so was never brought
  // under that gate — an anonymous caller can currently store an orphaned blob even if they could
  // never attach it to a real record (blocked by the eventual create/update's own permission check)
  // — `maxSize` bounds the resulting storage cost but this is a known gap, not a design choice.
  app.post('/:model/:field/upload', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const field = resolveFileField(model, c.req.param('field'));

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

    const key = `${model.name}/${c.req.param('field')}/${generateId()}`;
    // `Buffer.from(bytes)`, not `bytes` itself: flystorage's `write()` turns any non-`Readable`
    // `contents` into a stream via Node's `Readable.from()`, which special-cases `Buffer` as one
    // opaque chunk — a plain `Uint8Array` instead gets iterated byte-by-byte into a stream of
    // individual numbers, silently corrupting the upload.
    await requireStorage(storage).write(key, Buffer.from(bytes), { mimeType });

    const stored: StoredFile = { key, filename: file.name, mimeType, size: bytes.byteLength };
    return c.json({ data: stored }, 201);
  });

  app.post('/:model', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const { user, granted } = await resolveFieldAccess(db, c.req.raw, model, 'create');
    const input = await readJsonBody(c);
    assertWriteFieldsAllowed(model, input, granted);
    const ctx: OperationContext = {
      operation: 'create',
      input,
      doc: null,
      model,
      db,
      request: c.req.raw,
      registry,
      user: toCtxUser(user),
    };
    const result = await model.operations.create(ctx);
    return c.json({ data: result.doc && toResponseRow(model, result.doc) }, 201);
  });

  app.patch('/:model/:id', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const { user, granted } = await resolveFieldAccess(db, c.req.raw, model, 'update');
    const input = await readJsonBody(c);
    assertWriteFieldsAllowed(model, input, granted);
    const oldDoc = fileFieldsOf(model).length > 0 ? await fetchRow(db, model, c.req.param('id')) : null;
    const ctx: OperationContext = {
      operation: 'update',
      id: c.req.param('id'),
      input,
      doc: null,
      model,
      db,
      request: c.req.raw,
      registry,
      user: toCtxUser(user),
    };
    const result = await model.operations.update(ctx);
    if (result.doc) await cleanupReplacedFiles(storage, model, oldDoc, result.doc);
    return c.json({ data: result.doc && toResponseRow(model, result.doc) });
  });

  // `POST /:model/:id/:operation` — the one generic route for every custom operation (core/
  // model.ts's `CustomOperationDefinition`, e.g. `lock`/`unlock`): always POST, always record-
  // scoped, regardless of what the operation's own pipeline does internally (Q12). Must be
  // registered after `/:model/:field/upload` above — this router (router/http-app.ts) resolves
  // two routes with the same segment count by registration order, not by preferring the static
  // ('upload') segment, so this route registered first would shadow every model's upload endpoint.
  // `'upload'` is also a
  // reserved operation name (`RESERVED_OPERATION_NAMES`, core/model.ts) as a second line of
  // defense. `create`/`update`/`remove` 404 here too — they already have dedicated routes above
  // that apply this router's own field-permission check (`assertWriteFieldsAllowed`); dispatching
  // them through this route would run the raw builtin pipeline without it.
  app.post('/:model/:id/:operation', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const operationName = c.req.param('operation');
    if (operationName === 'create' || operationName === 'update' || operationName === 'remove') {
      throw new PipelineError({ code: 'OPERATION_NOT_FOUND', status: 404 });
    }
    const entry = model.operations[operationName];
    if (!entry) throw new PipelineError({ code: 'OPERATION_NOT_FOUND', status: 404 });
    const def: CustomOperationDefinition | undefined = typeof entry === 'function' ? undefined : entry;
    const pipelineFn = typeof entry === 'function' ? entry : entry.pipeline;

    // Resource-level "can this role invoke this operation at all" gate (`resource:operationName`)
    // — the operation's own field-level checks, for whatever it actually writes, are that
    // operation's own job (see `presetFields`, ratchet/auth): a generic `PipelineFn` here isn't
    // knowable up front the way a `PATCH` body already is.
    const { user } = await resolveAccess(db, c.req.raw, model, operationName);

    let input: Record<string, unknown> = {};
    if (def?.params) {
      const body = await readJsonBody(c);
      const result = buildParamsSchema(def.params).safeParse(body);
      if (!result.success) {
        const fields: Record<string, string> = {};
        for (const issue of result.error.issues) {
          const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          if (!(key in fields)) fields[key] = issue.message;
        }
        throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields });
      }
      input = result.data as Record<string, unknown>;
    }

    const ctx: OperationContext = {
      operation: operationName,
      id: c.req.param('id'),
      input,
      doc: null,
      model,
      db,
      request: c.req.raw,
      registry,
      user: toCtxUser(user),
    };
    const result = await pipelineFn(ctx);
    return c.json({ data: result.doc && toResponseRow(model, result.doc) });
  });

  app.delete('/:model/:id', async (c) => {
    const model = resolveModel(registry, c.req.param('model'));
    const { user } = await resolveAccess(db, c.req.raw, model, 'remove');
    const ctx: OperationContext = {
      operation: 'remove',
      id: c.req.param('id'),
      input: {},
      doc: null,
      model,
      db,
      request: c.req.raw,
      registry,
      user: toCtxUser(user),
    };
    const result = await model.operations.remove(ctx);
    return c.json({ data: result.doc && toResponseRow(model, result.doc) });
  });

  return app;
}
