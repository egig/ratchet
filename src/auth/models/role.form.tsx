/**
 * The framework's own built-in console form for `Role` (see `../console-forms.ts`, wired into
 * codegen's `BUILTIN_FORMS` — `src/codegen/builtins.ts`) — every consuming app gets this in place
 * of the generated create/edit form for `roles`, the same as if it had authored its own
 * `roles.form.tsx` (docs/guide/console.md#custom-forms), unless it actually does (a consumer's own
 * `roles.form.tsx` takes precedence — see `generate()`, src/codegen/generate.ts).
 *
 * Combines editing the role's own fields with managing its entire `permissions` grant array
 * (`role.model.ts`) in one Save — a plain `POST`/`PATCH` write like any other field, no custom
 * operation involved. Permissions render as a tree of checkboxes:
 *
 *   *  (All resources)      <- checking this grants everything; nothing else matters
 *     -> <resource>          <- checking this grants every action (and field) on it
 *        -> <action>          <- checking this grants every field of a field-shaped action
 *           -> <field>          <- individual field grant
 *
 * A fully-checked subtree always collapses to one wildcard row (`action: '*'` or `field: '*'`)
 * rather than one row per child — the same shape a hand-written grant would use.
 */
import { useEffect, useRef, useState } from 'react';
import { createRow, getRow, updateRow, type ModelFormProps } from '../../console/client/index.js';

interface Target {
  resource: string;
  action: string;
  field?: string;
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

function isGlobalGranted(targets: Target[]): boolean {
  return targets.some((t) => t.resource === '*' && t.action === '*');
}

function isResourceGranted(targets: Target[], resource: string): boolean {
  return isGlobalGranted(targets) || targets.some((t) => t.resource === resource && t.action === '*');
}

/** The field keys currently granted for one `(resource, action)` pair — `'*'` expands to every
 * field `allFieldKeys` names, so toggling a single field off a wildcard grant has something
 * concrete to remove one key from. */
function grantedFieldKeys(targets: Target[], resource: string, action: string, allFieldKeys: string[]): string[] {
  if (targets.some((t) => t.resource === resource && t.action === action && t.field === '*')) return allFieldKeys;
  return targets.filter((t) => t.resource === resource && t.action === action && t.field && t.field !== '*').map((t) => t.field!);
}

function actionState(targets: Target[], resource: string, action: string, fieldShaped: boolean, allFieldKeys: string[]): CheckState {
  if (isResourceGranted(targets, resource)) return 'checked';
  if (!fieldShaped) {
    return targets.some((t) => t.resource === resource && t.action === action) ? 'checked' : 'unchecked';
  }
  const granted = grantedFieldKeys(targets, resource, action, allFieldKeys);
  if (granted.length === 0) return 'unchecked';
  if (granted.length === allFieldKeys.length) return 'checked';
  return 'indeterminate';
}

/** Replaces every field-level row for one `(resource, action)` with a fresh set — collapsing back
 * to a single `field: '*'` row when the new set covers every field, dropping the action's rows
 * entirely when it's empty, same "desired set, not a patch" shape the whole `permissions` array
 * is saved as (one `PATCH`/`POST` write of the entire array, not a per-row diff). */
function replaceActionFields(targets: Target[], resource: string, action: string, fieldKeys: string[], allFieldKeys: string[]): Target[] {
  const rest = targets.filter((t) => !(t.resource === resource && t.action === action));
  if (fieldKeys.length === 0) return rest;
  if (fieldKeys.length === allFieldKeys.length) return [...rest, { resource, action, field: '*' }];
  return [...rest, ...fieldKeys.map((field) => ({ resource, action, field }))];
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

export default function RoleForm({ model, mode, id, fields, onDone, models }: ModelFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [targets, setTargets] = useState<Target[]>([]);
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
      setTargets(
        ((row.permissions as { resource: string; action: string; field?: string | null }[] | null) ?? []).map((r) => ({
          resource: r.resource,
          action: r.action,
          field: r.field ?? undefined,
        })),
      );
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
    setTargets(checked ? [{ resource: '*', action: '*', field: '*' }] : []);
  }

  function toggleResource(resource: string, checked: boolean) {
    setTargets((prev) => {
      const rest = prev.filter((t) => t.resource !== resource);
      return checked ? [...rest, { resource, action: '*', field: '*' }] : rest;
    });
  }

  function toggleAction(resource: string, action: string, fieldShaped: boolean, allFieldKeys: string[], checked: boolean) {
    setTargets((prev) => {
      if (!fieldShaped) {
        const rest = prev.filter((t) => !(t.resource === resource && t.action === action));
        return checked ? [...rest, { resource, action }] : rest;
      }
      return replaceActionFields(prev, resource, action, checked ? allFieldKeys : [], allFieldKeys);
    });
  }

  function toggleField(resource: string, action: string, field: string, allFieldKeys: string[], checked: boolean) {
    setTargets((prev) => {
      const current = new Set(grantedFieldKeys(prev, resource, action, allFieldKeys));
      if (checked) current.add(field);
      else current.delete(field);
      return replaceActionFields(prev, resource, action, [...current], allFieldKeys);
    });
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await createRow(model.name, { ...values, permissions: targets });
      } else {
        await updateRow(model.name, id!, { ...values, permissions: targets });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;

  const globalGranted = isGlobalGranted(targets);

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
            const resourceGranted = isResourceGranted(targets, resource.name);
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
                    const state = actionState(targets, resource.name, action.name, action.fieldShaped, allFieldKeys);
                    return (
                      <li key={action.name}>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <TriCheckbox
                            state={state}
                            disabled={globalGranted || resourceGranted}
                            onChange={(checked) => toggleAction(resource.name, action.name, action.fieldShaped, allFieldKeys, checked)}
                          />
                          {action.label}
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
                                        grantedFieldKeys(targets, resource.name, action.name, allFieldKeys).includes(f.key)
                                          ? 'checked'
                                          : 'unchecked'
                                      }
                                      disabled={globalGranted || resourceGranted}
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
