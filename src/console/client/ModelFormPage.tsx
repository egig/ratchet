import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { ConsoleFieldMeta, ConsoleModelMeta } from '../serialize-model.js';
import { useModels } from './models.js';
import { useAuth } from './auth.js';
import { ApiRequestError, createRow, getRow, hasPermission, updateRow } from './api.js';
import { FieldInput, resourceFieldKey, type FileFieldValue } from './fields.js';
import { OperationButton } from './OperationButton.js';
import { queryKeys } from './query-keys.js';
import { datetimeLocalToIso, isoToDatetimeLocal } from './format.js';
import { CheckIcon, XMarkIcon } from './icons.js';
import { createModelFieldRenderers, useCustomForms } from './custom-forms.js';
import { Button } from './ui/button.js';

type FormValues = Record<string, string | boolean | FileFieldValue | string[]>;

function inputKeyFor(f: ConsoleFieldMeta): string {
  return f.writeAs ?? f.key;
}

function effectiveRequired(f: ConsoleFieldMeta, mode: 'create' | 'update'): boolean {
  return f.writeAs ? mode === 'create' && f.required : f.required;
}

function initialValues(model: ConsoleModelMeta, row: Record<string, unknown> | null): FormValues {
  const values: FormValues = {};
  for (const f of model.fields) {
    if (f.sensitive && !f.writeAs) continue; // never writable through a declared key
    const key = inputKeyFor(f);
    const raw = row ? row[f.key] : (f.default as unknown);
    if (f.kind === 'boolean') {
      values[key] = Boolean(raw);
    } else if (f.kind === 'datetime') {
      values[key] = isoToDatetimeLocal(raw);
    } else if (f.kind === 'json') {
      values[key] = raw === undefined || raw === null ? '' : JSON.stringify(raw, null, 2);
    } else if (f.kind === 'file') {
      // an existing record's `{ url, filename, mimeType, size }` (display-only — buildPayload
      // never resubmits this, only a fresh upload's `{ key, ... }`); absent entirely for "no file yet".
      if (raw && typeof raw === 'object') values[key] = raw as FileFieldValue;
    } else if (f.kind === 'manyToMany' || f.kind === 'referenceToMany') {
      // `raw` is the array of full target rows the edit form's `?include=` fetch returned (see
      // ModelFormPage's rowQuery below); absent (create mode, or a row with none attached yet) ->
      // empty selection. referenceToMany's children arrive the same way from the server's
      // `attachReferenceToManyIncludes` (router/list.ts).
      values[key] = Array.isArray(raw) ? raw.map((item) => String((item as Record<string, unknown>).id)) : [];
    } else if (f.writeAs) {
      values[key] = ''; // password et al: never round-tripped from a read
    } else {
      values[key] = raw === undefined || raw === null ? '' : String(raw);
    }
  }
  return values;
}

function buildPayload(model: ConsoleModelMeta, values: FormValues, mode: 'create' | 'update'): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of model.fields) {
    if (f.sensitive && !f.writeAs) continue;
    const key = inputKeyFor(f);
    const raw = values[key];
    const required = effectiveRequired(f, mode);

    if (f.writeAs && mode === 'update' && (raw === '' || raw === undefined)) continue; // leave unchanged

    switch (f.kind) {
      case 'boolean':
        payload[key] = Boolean(raw);
        break;
      case 'integer':
        if (raw === '' || raw === undefined) {
          if (required) payload[key] = raw;
          break;
        }
        payload[key] = Number(raw);
        break;
      case 'json':
        if (raw === '' || raw === undefined) {
          if (required) payload[key] = raw;
          break;
        }
        payload[key] = JSON.parse(raw as string);
        break;
      case 'datetime':
        if (raw === '' || raw === undefined) {
          if (required) payload[key] = raw;
          break;
        }
        payload[key] = datetimeLocalToIso(raw as string);
        break;
      case 'file': {
        // only a fresh upload (has `key`) is ever resubmitted — an untouched existing file
        // (display-only `{ url, ... }`) is left out entirely, same "leave unchanged" convention
        // as writeAs/password on update; on create, omitting a required file is caught server-side.
        const stored = raw as FileFieldValue | undefined;
        if (stored?.key) payload[key] = { key: stored.key, filename: stored.filename, mimeType: stored.mimeType, size: stored.size };
        break;
      }
      case 'manyToMany':
      case 'referenceToMany':
        // always the full desired set, never a diff — the server (core/pipeline.ts's
        // syncManyToMany / syncReferenceToManyFields) replaces the whole relation against whatever
        // array is sent.
        payload[key] = Array.isArray(raw) ? raw : [];
        break;
      case 'tree':
        // Unlike a plain optional field (the `default` branch below), an empty value here is
        // never "leave unchanged" — `''` is `TreeCombobox`'s "Clear (make root)" choice, and has
        // to reach the server as an explicit `null` (core/validation.ts's `tree` case is
        // `.nullable()` for exactly this) or reparenting to root would silently no-op.
        payload[key] = raw === '' || raw === undefined ? null : raw;
        break;
      default:
        if ((raw === '' || raw === undefined) && !required) break;
        payload[key] = raw;
    }
  }
  return payload;
}

export interface ModelFormPageProps {
  /** called after a successful save, or when Cancel is clicked — the caller decides what "done"
   * means (e.g. `ModelFormDialog` navigates back to the page the dialog is layered over). */
  onDone: () => void;
}

export function ModelFormPage({ onDone }: ModelFormPageProps) {
  const { model: modelName, id } = useParams<{ model: string; id?: string }>();
  const { getModel, models, loading: modelsLoading } = useModels();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const model = modelName ? getModel(modelName) : undefined;
  const mode: 'create' | 'update' = id ? 'update' : 'create';
  // a registered `<name>.form.tsx` (see custom-forms.tsx) replaces everything below — its own
  // data fetching/mutations, not this component's — so this component's own `rowQuery` would
  // just be a wasted duplicate request in that case.
  const customForms = useCustomForms();
  const CustomForm = model ? customForms[model.name] : undefined;
  const customFormFields = useMemo(() => (model ? createModelFieldRenderers(model, mode) : {}), [model, mode]);

  // manyToMany / referenceToMany fields are never on the row's own JSON by default — the edit form
  // has to explicitly `?include=` each one to seed the multi-select with the record's current
  // selection. referenceToMany children arrive the same way (router/list.ts attaches them as an array).
  const manyToManyIncludes = model?.fields.filter((f) => f.kind === 'manyToMany' || f.kind === 'referenceToMany').map((f) => f.key) ?? [];
  const rowQuery = useQuery({
    queryKey: queryKeys.row(modelName ?? '', id ?? ''),
    queryFn: () => getRow(model!.name, id!, { include: manyToManyIncludes }),
    enabled: mode === 'update' && !!model && !CustomForm,
  });

  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    if (mode === 'create') {
      setValues(initialValues(model, null));
    } else if (rowQuery.data) {
      setValues(initialValues(model, rowQuery.data));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.name, id, mode, rowQuery.data]);

  const loading = mode === 'update' && rowQuery.isLoading;
  const loadError =
    mode === 'update' && rowQuery.error
      ? rowQuery.error instanceof Error
        ? rowQuery.error.message
        : 'failed to load record'
      : null;

  function refetchRows() {
    if (!model) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.rows(model.name), exact: false });
  }

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => createRow(model!.name, payload),
    onSuccess: refetchRows,
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => updateRow(model!.name, id!, payload),
    onSuccess: (updated) => {
      refetchRows();
      queryClient.setQueryData(queryKeys.row(model!.name, id!), updated);
    },
  });

  if (modelsLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!model) return <p className="text-sm text-destructive">Unknown model.</p>;
  if (CustomForm) return <CustomForm model={model} mode={mode} id={id} onDone={() => {
    refetchRows();
    onDone()
  }} fields={customFormFields} models={models} />;
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const resourceKey = resourceFieldKey(model);

  function handleChange(key: string, value: unknown) {
    setValues((prev) => {
      const next = { ...prev, [key]: value as string | boolean | FileFieldValue };
      // the chosen resource decides which actions/fields are valid — switching it must not
      // leave a stale `action`/`field` from the previous resource behind.
      if (key === resourceKey) {
        for (const f of model!.fields) {
          if (f.kind === 'actionRef' || f.kind === 'fieldRef') next[f.key] = '';
        }
      }
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFieldErrors({});
    try {
      const payload = buildPayload(model!, values, mode);
      if (mode === 'create') {
        await createMutation.mutateAsync(payload);
      } else {
        await updateMutation.mutateAsync(payload);
      }
      onDone();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setFormError('One of the JSON fields is not valid JSON.');
      } else if (err instanceof ApiRequestError) {
        setFormError(err.fields ? null : err.message);
        setFieldErrors(err.fields ?? {});
      } else {
        setFormError(err instanceof Error ? err.message : 'save failed');
      }
    }
  }

  const submitting = createMutation.isPending || updateMutation.isPending;

  function refetchRow() {
    if (mode !== 'update') return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.row(model!.name, id!) });
  }

  const detailOperations =
    mode === 'update'
      ? model.operations.filter((op) => op.placement.includes('detail') && hasPermission(user?.permissions ?? {}, model.name, op.name))
      : [];

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-foreground">
        {mode === 'create' ? `New ${model.label.replace(/s$/, '')}` : `Edit ${model.label.replace(/s$/, '')}`}
      </h1>

      {(formError ?? loadError) && <p className="mb-4 text-sm text-destructive">{formError ?? loadError}</p>}

      <form onSubmit={handleSubmit} className="space-y-4">
        {model.fields
          .filter((f) => !f.sensitive || f.writeAs)
          .filter((f) => {
            // `actionRef`/`fieldRef` are sub-selectors of the `modelRef` ("resource") field —
            // hide them until a resource is picked (choosing '*' counts and reveals them).
            if ((f.kind === 'actionRef' || f.kind === 'fieldRef') && resourceKey) {
              return Boolean(values[resourceKey]);
            }
            return true;
          })
          .map((f) => {
            const key = inputKeyFor(f);
            return (
              <label key={key} className="block text-sm">
                <span className="mb-1 block text-foreground">
                  {f.label}
                  {effectiveRequired(f, mode) && <span className="text-destructive"> *</span>}
                </span>
                <FieldInput
                  field={f}
                  inputKey={key}
                  value={values[key]}
                  onChange={handleChange}
                  error={fieldErrors[key] ?? (f.writeAs ? fieldErrors[f.key] : undefined)}
                  mode={mode}
                  modelName={model.name}
                  recordId={mode === 'update' ? id : undefined}
                  formValues={values}
                  formModel={model}
                />
              </label>
            );
          })}

        <div className="flex gap-2 pt-2">
          <Button type="submit" disabled={submitting}>
            <CheckIcon className="h-4 w-4" />
            {submitting ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            <XMarkIcon className="h-4 w-4" />
            Cancel
          </Button>
        </div>
      </form>

      {detailOperations.length > 0 && (
        <div className="mt-4 flex gap-4 border-t border-border pt-4">
          {detailOperations.map((op) => (
            <OperationButton
              key={op.name}
              modelName={model.name}
              id={id!}
              row={rowQuery.data ?? null}
              operation={op}
              onDone={() => void refetchRow()}
              className="text-sm text-muted-foreground hover:underline"
            />
          ))}
        </div>
      )}
    </div>
  );
}
