import { fetchRow, insertRow, updateRow, hardRemoveRow } from '../core/persistence.js';
import { listRows, getOneRow } from '../router/list.js';
import { parseListQuery, parseInclude } from '../router/query.js';
import { assertReadFieldsAllowed, filterIncludedRelations } from '../router/read-access.js';
import { readJsonBody } from '../router/create-router.js';
import { toErrorResponse } from '../router/errors.js';
import { listPermissionsForRole } from '../auth/lookup.js';
import {
  authorizeRequest,
  resolveSessionUser,
  resolveGrantedFields,
  assertWriteFieldsAllowed,
  pickGrantedFields,
} from '../auth/pipeline.js';
import { normalizeJsonFields, redactSensitiveFields } from '../core/serialize.js';
import { rowToCamelCase } from '../core/naming.js';
import { serializeModelMeta } from '../console/serialize-model.js';

/**
 * The building blocks a plugin composes, grouped by concern. These are the same functions core's
 * own routers use, so a plugin's reads/writes get identical validation, field-level access and
 * serialization — but they reach a plugin only through `PluginContext.kit`, never as package
 * subpath exports, so core can reshape its internals without breaking plugins as long as this
 * object's shape holds (`PLUGIN_API_VERSION`). Every function takes its `db` explicitly so a
 * plugin can pass a transaction handle.
 */
export const pluginToolkit = {
  /** raw row persistence — no permission checks; for a plugin's own tables */
  data: { fetchRow, insertRow, updateRow, hardRemoveRow, listRows, getOneRow },
  /** query-string parsing + read-side field access, as `GET /api/:model` applies them */
  query: { parseListQuery, parseInclude, assertReadFieldsAllowed, filterIncludedRelations },
  /** sessions, grants and field-level access */
  access: {
    resolveSessionUser,
    authorizeRequest,
    listPermissionsForRole,
    resolveGrantedFields,
    assertWriteFieldsAllowed,
    pickGrantedFields,
  },
  /** request/response helpers for a plugin's `App` */
  http: { readJsonBody, toErrorResponse },
  /** row/model serialization */
  serialize: { rowToCamelCase, normalizeJsonFields, redactSensitiveFields, modelMeta: serializeModelMeta },
};

export type PluginToolkit = typeof pluginToolkit;
