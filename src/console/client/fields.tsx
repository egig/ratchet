import { useMemo, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ConsoleFieldMeta, ConsoleModelMeta } from '../serialize-model.js';
import { listRows, uploadFile, uploadDomainSettingsFile } from './api.js';
import { useModels } from './models.js';
import { useFieldRenderers } from './field-renderers.js';
import { useFieldInputOverrides } from './field-input-overrides.js';
import { queryKeys } from './query-keys.js';
import { ReferenceCombobox } from './ReferenceCombobox.js';
import { TreeCombobox } from './TreeCombobox.js';
import { ManyToManyMultiSelect } from './ManyToManyMultiSelect.js';
import { CodeEditor } from './CodeEditor.js';

/** What a `file` field's form value looks like — either an existing record's read shape
 * (`{ url, filename, mimeType, size }`, from `deriveFileFields`) or a fresh upload's response
 * (`UploadedFile`, `{ key, filename, mimeType, size }`). Distinguished by which of `url`/`key`
 * is present; see `buildPayload` in `ModelFormPage.tsx`, which only resubmits the latter. */
export type FileFieldValue = { url?: string; key?: string; filename: string; mimeType: string; size: number };

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

export interface ReferenceOption {
  id: string;
  label: string;
}

/** Fetches up to 100 rows of a reference field's target model to populate a `<select>` — a
 * plain fetched-into-a-dropdown list, not a searchable/paginated combobox; fine for console-scale
 * lookups, not meant to scale to huge target tables. Shares its `queryKeys.rows(targetModel, ...)`
 * cache entry with `RowTable`'s own listing of that model, so creating/editing a row there
 * invalidates this dropdown's options too. */
export function useReferenceOptions(targetModel: string | undefined): ReferenceOption[] | null {
  const { getModel } = useModels();
  const displayField = targetModel ? (getModel(targetModel)?.displayField ?? 'id') : 'id';
  const listParams = useMemo(() => ({ limit: 100, offset: 0 }), []);

  const { data, error } = useQuery({
    queryKey: queryKeys.rows(targetModel ?? '', listParams),
    queryFn: () => listRows(targetModel!, listParams),
    enabled: !!targetModel,
  });

  if (!targetModel) return null;
  if (error) return [];
  if (!data) return null;
  return data.rows.map((row) => ({ id: String(row.id), label: String(row[displayField] ?? row.id) }));
}

export interface FieldInputProps {
  field: ConsoleFieldMeta;
  inputKey: string;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  error?: string;
  /** create vs update — a `writeAs` (e.g. password) field is required on create but optional
   * (blank = leave unchanged) on update. */
  mode: 'create' | 'update';
  /** only needed by `kind: 'file'`, to build its upload URL (`POST /api/:modelName/:field/upload`).
   * Mutually exclusive with `domainName` — a field belongs to a model's create/update form or a
   * Domain's settings form, never both. */
  modelName?: string;
  /** `kind: 'file'`'s Domain Settings equivalent of `modelName` — set by `DomainSettingsForm`,
   * builds the upload URL `POST {MOUNT_PREFIX}/meta/domains/:domainName/settings/:field/upload`
   * instead (`console/router.ts`). */
  domainName?: string;
  /** the record being edited, for `kind: 'tree'` (`TreeCombobox` excludes it and its descendants
   * from the parent picker — reparenting under either would create a cycle). Absent on create,
   * where there's no id yet. */
  recordId?: string;
  /** the whole form's current values + its model meta. Lets an `actionRef` sub-field scope its
   * option list to the sibling `modelRef` ("resource") chosen elsewhere on the same form (its
   * parent form also uses these to hide `actionRef`/`fieldRef` until a resource is picked).
   * Absent for forms with no such cross-field dependency (operation params, domain settings). */
  formValues?: Record<string, unknown>;
  formModel?: ConsoleModelMeta;
}

/** The key of the form's `modelRef` field (e.g. `targetModel` on `WorkspaceView`) — the field an
 * `actionRef`/`fieldRef` sub-selector depends on. `undefined` when the form has no `modelRef`
 * field at all. */
export function resourceFieldKey(model: ConsoleModelMeta | undefined): string | undefined {
  return model?.fields.find((f) => f.kind === 'modelRef')?.key;
}

export function FieldInput(props: FieldInputProps) {
  const { field, inputKey, value, onChange, error, mode, modelName, domainName, recordId } = props;
  const { models: modelRefOptions } = useModels();
  const fieldRenderers = useFieldRenderers();
  const fieldInputOverrides = useFieldInputOverrides();
  const required = field.writeAs ? mode === 'create' && field.required : field.required;
  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      domainName ? uploadDomainSettingsFile(domainName, field.key, file) : uploadFile(modelName!, field.key, file),
    onSuccess: (result) => onChange(inputKey, result),
  });

  const errorEl = error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null;
  const wrap = (input: ReactNode) => (
    <div>
      {input}
      {errorEl}
    </div>
  );

  // a `<model>.<field>.input.tsx` (see field-input-overrides.tsx) is the most specific override —
  // no model change needed to declare it, just a file on disk naming this exact field — so it
  // wins over a `field.custom()` renderer, which itself wins over the kind-based switch below.
  const fieldInputOverride = modelName ? fieldInputOverrides[modelName]?.[field.key] : undefined;
  if (fieldInputOverride) return fieldInputOverride(props);

  const customRenderer = field.customType ? fieldRenderers[field.customType] : undefined;
  if (customRenderer) return customRenderer(props);

  // built in regardless of `fieldRenderers` (no app-level registration needed) — a CodeJar editor
  // for any `field.custom('code', ...)` field.
  if (field.customType === 'code') {
    return wrap(<CodeEditor value={(value as string) ?? ''} onChange={(v) => onChange(inputKey, v)} />);
  }

  // the sibling `modelRef` value, for scoping an `actionRef` dropdown — '' (nothing picked) or
  // '*' both fall back to the registry-wide union.
  const resourceKey = resourceFieldKey(props.formModel);
  const selectedResource =
    resourceKey && typeof props.formValues?.[resourceKey] === 'string'
      ? (props.formValues[resourceKey] as string)
      : '';

  switch (field.kind) {
    case 'text':
      return wrap(
        <textarea
          required={required}
          rows={3}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );

    case 'json':
      return wrap(
        <textarea
          required={required}
          rows={5}
          spellCheck={false}
          placeholder="{}"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={`${inputClass} font-mono`}
        />,
      );

    case 'boolean':
      return wrap(
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(inputKey, e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />,
      );

    case 'integer':
      return wrap(
        <input
          type="number"
          step={1}
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );

    case 'decimal':
      return wrap(
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );

    case 'datetime':
      return wrap(
        <input
          type="datetime-local"
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );

    case 'enum':
      return wrap(
        <select
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        >
          {!required && <option value="">—</option>}
          {field.values?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>,
      );

    case 'reference':
      return wrap(
        <ReferenceCombobox
          targetModel={field.targetModel ?? ''}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(inputKey, v)}
          required={required}
        />,
      );

    case 'tree':
      return wrap(
        <TreeCombobox
          targetModel={field.targetModel ?? ''}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(inputKey, v)}
          required={required}
          excludeId={recordId}
        />,
      );

    case 'manyToMany':
    case 'referenceToMany':
      // both hold an array of target-row ids and render identically — referenceToMany's children are
      // stored as an FK column on the target (one parent per child), manyToMany's in a junction; the
      // form input is the same multi-select either way.
      return wrap(
        <ManyToManyMultiSelect
          targetModel={field.targetModel ?? ''}
          value={(value as string[]) ?? []}
          onChange={(v) => onChange(inputKey, v)}
        />,
      );

    case 'modelRef':
      return wrap(
        <select
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        >
          <option value="">{required ? '— select —' : '—'}</option>
          {field.allowWildcard && <option value="*">* (all resources)</option>}
          {modelRefOptions.map((m) => (
            <option key={m.name} value={m.name}>
              {m.label}
            </option>
          ))}
        </select>,
      );

    case 'actionRef': {
      // when a concrete resource is chosen, only offer *its* operations; otherwise ('' or '*')
      // fall back to the registry-wide union, matching `validateRolePermissions`'s check.
      const scopedModel =
        selectedResource && selectedResource !== '*'
          ? modelRefOptions.find((m) => m.name === selectedResource)
          : undefined;
      const actionOptions = scopedModel
        ? [...scopedModel.operationNames].sort()
        : [...new Set(modelRefOptions.flatMap((m) => m.operationNames))].sort();
      return wrap(
        <select
          required={required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        >
          <option value="">{required ? '— select —' : '—'}</option>
          {field.allowWildcard && <option value="*">* (all actions)</option>}
          {actionOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>,
      );
    }

    case 'file': {
      const stored = value as FileFieldValue | undefined;
      return wrap(
        <div>
          {stored && (
            <div className="mb-2 flex items-center gap-2">
              {field.preview === 'image' && stored.url && (
                <img
                  src={stored.url}
                  alt={stored.filename}
                  className="h-16 w-16 rounded border border-gray-200 object-cover"
                />
              )}
              <span className="text-sm text-gray-600">{stored.filename}</span>
            </div>
          )}
          <input
            type="file"
            accept={field.accept}
            required={required && !stored}
            disabled={uploadMutation.isPending || (!modelName && !domainName)}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (!picked || (!modelName && !domainName)) return;
              uploadMutation.mutate(picked);
            }}
            className={inputClass}
          />
          {uploadMutation.isPending && <p className="mt-1 text-xs text-gray-500">Uploading…</p>}
          {uploadMutation.error && (
            <p className="mt-1 text-xs text-red-600">
              {uploadMutation.error instanceof Error ? uploadMutation.error.message : 'upload failed'}
            </p>
          )}
        </div>,
      );
    }

    // No live cross-field dropdown (the field this names lives on whichever model a *sibling*
    // `resource` value points at, which this component doesn't have visibility into) — falls
    // through to a plain text input, same as 'string', with a hint about the wildcard.
    case 'fieldRef':
      return wrap(
        <input
          type="text"
          required={required}
          placeholder={field.allowWildcard ? "field name, or '*' for every field" : 'field name'}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );

    case 'string':
    default:
      return wrap(
        <input
          type={field.writeAs ? 'password' : 'text'}
          required={required}
          maxLength={field.kind === 'string' ? field.maxLength : undefined}
          placeholder={field.writeAs && mode === 'update' ? 'Leave blank to keep unchanged' : undefined}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(inputKey, e.target.value)}
          className={inputClass}
        />,
      );
  }
}
