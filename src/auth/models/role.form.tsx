/**
 * The framework's own built-in console form for `Role` (see `../console-forms.ts`, wired into
 * codegen's `BUILTIN_FORMS` — `src/codegen/builtins.ts`) — every consuming app gets this in place
 * of the generated create/edit form for `roles`, the same as if it had authored its own
 * `roles.form.tsx` (docs/guide/console.md#custom-forms), unless it actually does (a consumer's own
 * `roles.form.tsx` takes precedence — see `generate()`, src/codegen/generate.ts).
 *
 * Combines editing the role's own fields with managing its entire `permissions` grant tree
 * (`role.model.ts`) in one Save — a plain `POST`/`PATCH` write like any other field, no custom
 * operation involved. Permissions render as a tree of checkboxes, `resource -> action -> field`:
 *
 *   *  (All resources)      <- checking this grants everything; nothing else matters
 *     -> <resource>          <- checking this grants every action (and field) on it
 *        -> <action>          <- checking this grants every field of a field-shaped action;
 *                                 an own/any toggle appears here too (every model has an owner)
 *           -> <field>          <- individual field grant
 *
 * A fully-checked subtree always collapses to one wildcard key (`action: '*'` or `fields: '*'`)
 * rather than one entry per child, and — per `validateRolePermissions` (ratchet/auth) — a `'*'`
 * key never coexists with a sibling specific key at the same level, so every mutation here
 * computes a whole level's desired key set fresh rather than patching one row at a time.
 */
import { useEffect, useRef, useState } from 'react';
import { createRow, getRow, updateRow, type ModelFormProps } from '../../console/client/index.js';

/** Mirrors `ratchet/auth`'s `ActionGrant`/`RolePermissions` (src/auth/lookup.ts) — duplicated
 * rather than imported so this browser-bundled form never pulls in that module's server-only
 * dependencies, the same reasoning as `console/client/api.ts`'s own copy. */
interface ActionGrant {
  fields?: '*' | string[];
  scope?: 'own' | 'any';
}
type RolePermissions = Record<string, Record<string, ActionGrant>>;

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

function isGlobalGranted(permissions: RolePermissions): boolean {
  return permissions['*']?.['*'] !== undefined;
}

function isResourceGranted(permissions: RolePermissions, resource: string): boolean {
  return isGlobalGranted(permissions) || permissions[resource]?.['*'] !== undefined;
}

/** The field keys currently granted for one `(resource, action)` pair — `fields: '*'` expands to
 * every field `allFieldKeys` names, so toggling a single field off a wildcard grant has something
 * concrete to remove one key from. */
function grantedFieldKeys(permissions: RolePermissions, resource: string, action: string, allFieldKeys: string[]): string[] {
  const grant = permissions[resource]?.[action];
  if (!grant) return [];
  return grant.fields === '*' ? allFieldKeys : (grant.fields ?? []);
}

function actionState(permissions: RolePermissions, resource: string, action: string, fieldShaped: boolean, allFieldKeys: string[]): CheckState {
  if (isResourceGranted(permissions, resource)) return 'checked';
  if (!fieldShaped) {
    return permissions[resource]?.[action] !== undefined ? 'checked' : 'unchecked';
  }
  const granted = grantedFieldKeys(permissions, resource, action, allFieldKeys);
  if (granted.length === 0) return 'unchecked';
  if (granted.length === allFieldKeys.length) return 'checked';
  return 'indeterminate';
}

/** `'own'` is the default a role gets when a grant doesn't specify `scope` at all (matches the
 * server's own default, `resolveScope`/`authorizeRequest`, ratchet/auth) — so an ungranted action
 * shows `'own'` too, though the toggle stays disabled until the action is actually checked. */
function actionScope(permissions: RolePermissions, resource: string, action: string): 'own' | 'any' {
  return permissions[resource]?.[action]?.scope ?? 'own';
}

/** Replaces one resource's entire action map, dropping the resource key entirely once its action
 * map is empty — keeps `permissions` from accumulating `{}`  entries for a resource with nothing
 * granted on it. */
function setResourceActions(permissions: RolePermissions, resource: string, actionMap: Record<string, ActionGrant>): RolePermissions {
  const { [resource]: _drop, ...rest } = permissions;
  return Object.keys(actionMap).length === 0 ? rest : { ...rest, [resource]: actionMap };
}

/** Replaces one `(resource, action)` grant's field set — collapsing back to `fields: '*'` when the
 * new set covers every field, dropping the action entirely when it's empty, same "desired set, not
 * a patch" shape the whole `permissions` tree is saved as (one `PATCH`/`POST` write, not a per-node
 * diff). Preserves whatever `scope` the action already had. */
function replaceActionFields(
  permissions: RolePermissions,
  resource: string,
  action: string,
  fieldKeys: string[],
  allFieldKeys: string[],
): RolePermissions {
  const actionMap = permissions[resource] ?? {};
  const existingScope = actionMap[action]?.scope;
  const { [action]: _drop, ...restActions } = actionMap;
  if (fieldKeys.length === 0) return setResourceActions(permissions, resource, restActions);
  const fields = fieldKeys.length === allFieldKeys.length ? ('*' as const) : fieldKeys;
  const grant: ActionGrant = existingScope ? { fields, scope: existingScope } : { fields };
  return setResourceActions(permissions, resource, { ...restActions, [action]: grant });
}

function TriCheckbox({
  state,
  disabled,
  onChange,
}: {
  state: CheckState;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'indeterminate';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 rounded border-gray-300"
    />
  );
}

/** Own/any control for one action node — rendered for every resource, since every model has an
 * owner (`ConsoleModelMeta.ownerField`, `core/pipeline.ts`'s `ownerFieldOf`); disabled until the
 * action itself is actually granted (a scope on an ungranted action means nothing). */
function ScopeToggle({
  scope,
  disabled,
  onChange,
}: {
  scope: 'own' | 'any';
  disabled?: boolean;
  onChange: (scope: 'own' | 'any') => void;
}) {
  return (
    <select
      value={scope}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as 'own' | 'any')}
      className="rounded border border-gray-300 py-0.5 pl-1 pr-5 text-xs text-gray-600 disabled:opacity-50"
      title="Restrict this action to the requester's own rows, or allow every row"
    >
      <option value="own">own rows</option>
      <option value="any">any row</option>
    </select>
  );
}

export default function RoleForm({ model, mode, id, fields, onDone, models }: ModelFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [permissions, setPermissions] = useState<RolePermissions>({});
  const [loading, setLoading] = useState(mode === 'update');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mode !== 'update' || !id) return;
    let cancelled = false;
    void (async () => {
      const row = await getRow(model.name, id);
      if (cancelled) return;
      setValues({ name: row.name, description: row.description, workspaceTemplateId: row.workspaceTemplateId });
      setPermissions((row.permissions as RolePermissions | null) ?? {});
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, id]);

  function onFieldChange(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toggleGlobal(checked: boolean) {
    setPermissions(checked ? { '*': { '*': { fields: '*' } } } : {});
  }

  function toggleResource(resource: string, checked: boolean) {
    setPermissions((prev) => {
      const { [resource]: _drop, ...rest } = prev;
      return checked ? { ...rest, [resource]: { '*': { fields: '*' } } } : rest;
    });
  }

  function toggleAction(resource: string, action: string, fieldShaped: boolean, allFieldKeys: string[], checked: boolean) {
    setPermissions((prev) => {
      if (!fieldShaped) {
        const actionMap = prev[resource] ?? {};
        const { [action]: _drop, ...restActions } = actionMap;
        return setResourceActions(prev, resource, checked ? { ...restActions, [action]: {} } : restActions);
      }
      return replaceActionFields(prev, resource, action, checked ? allFieldKeys : [], allFieldKeys);
    });
  }

  function toggleField(resource: string, action: string, field: string, allFieldKeys: string[], checked: boolean) {
    setPermissions((prev) => {
      const current = new Set(grantedFieldKeys(prev, resource, action, allFieldKeys));
      if (checked) current.add(field);
      else current.delete(field);
      return replaceActionFields(prev, resource, action, [...current], allFieldKeys);
    });
  }

  function setScope(resource: string, action: string, scope: 'own' | 'any') {
    setPermissions((prev) => {
      const actionMap = prev[resource] ?? {};
      const grant = actionMap[action] ?? {};
      return setResourceActions(prev, resource, { ...actionMap, [action]: { ...grant, scope } });
    });
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await createRow(model.name, { ...values, permissions });
      } else {
        await updateRow(model.name, id!, { ...values, permissions });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  const globalGranted = isGlobalGranted(permissions);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">{mode === 'create' ? 'New Role' : 'Edit Role'}</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <label className="block text-sm">
        <span className="mb-1 block text-gray-700">{fields.name!.meta.label}</span>
        {fields.name!.render({ value: values.name, onChange: onFieldChange })}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-gray-700">{fields.description!.meta.label}</span>
        {fields.description!.render({ value: values.description, onChange: onFieldChange })}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-gray-700">{fields.workspaceTemplateId!.meta.label}</span>
        {fields.workspaceTemplateId!.render({ value: values.workspaceTemplateId, onChange: onFieldChange })}
      </label>

      <fieldset className="rounded border border-gray-200 p-3">
        <legend className="px-1 text-sm font-medium text-gray-700">Permissions</legend>

        <label className="flex items-center gap-2 text-sm font-medium">
          <TriCheckbox state={globalGranted ? 'checked' : 'unchecked'} onChange={toggleGlobal} />
          * — All resources
        </label>

        <ul className="mt-2 space-y-1 pl-5">
          {models.map((resource) => {
            const resourceGranted = isResourceGranted(permissions, resource.name);
            const actions = [
              { name: 'read', label: 'Read', fieldShaped: true },
              { name: 'create', label: 'Create', fieldShaped: true },
              { name: 'update', label: 'Update', fieldShaped: true },
              { name: 'remove', label: 'Remove', fieldShaped: false },
              ...resource.operations.map((op) => ({ name: op.name, label: op.label, fieldShaped: false })),
            ];
            const allFieldKeys = resource.fields.map((f) => f.key);

            return (
              <li key={resource.name}>
                <label className="flex items-center gap-2 text-sm">
                  <TriCheckbox
                    state={resourceGranted ? 'checked' : 'unchecked'}
                    disabled={globalGranted}
                    onChange={(checked) => toggleResource(resource.name, checked)}
                  />
                  {resource.label}
                </label>

                <ul className="mt-1 space-y-1 pl-5">
                  {actions.map((action) => {
                    const state = actionState(permissions, resource.name, action.name, action.fieldShaped, allFieldKeys);
                    const actionDisabled = globalGranted || resourceGranted;
                    return (
                      <li key={action.name}>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <TriCheckbox
                            state={state}
                            disabled={actionDisabled}
                            onChange={(checked) => toggleAction(resource.name, action.name, action.fieldShaped, allFieldKeys, checked)}
                          />
                          {action.label}
                          <ScopeToggle
                            scope={actionScope(permissions, resource.name, action.name)}
                            disabled={actionDisabled || state === 'unchecked'}
                            onChange={(scope) => setScope(resource.name, action.name, scope)}
                          />
                        </label>

                        {action.fieldShaped && allFieldKeys.length > 0 && (
                          <details className="pl-5">
                            <summary className="cursor-pointer text-xs text-gray-500">fields</summary>
                            <ul className="mt-1 space-y-1">
                              {resource.fields.map((f) => (
                                <li key={f.key}>
                                  <label className="flex items-center gap-2 text-xs text-gray-600">
                                    <TriCheckbox
                                      state={
                                        grantedFieldKeys(permissions, resource.name, action.name, allFieldKeys).includes(f.key)
                                          ? 'checked'
                                          : 'unchecked'
                                      }
                                      disabled={actionDisabled}
                                      onChange={(checked) => toggleField(resource.name, action.name, f.key, allFieldKeys, checked)}
                                    />
                                    {f.label}
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone} className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}
