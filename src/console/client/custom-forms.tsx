import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { ConsoleFieldMeta, ConsoleModelMeta } from '../serialize-model.js';
import { FieldInput, type FieldInputProps } from './fields.js';

/** What `fields[name].render(...)` (`ModelFieldRenderers` below) still needs from the caller —
 * everything else (`field`, `inputKey`, `modelName`, `mode`) is already bound by
 * `createModelFieldRenderers`, since it's the same for every call a given custom form makes. */
export type BoundFieldProps = Omit<FieldInputProps, 'field' | 'inputKey' | 'modelName' | 'mode'>;

export interface BoundField {
  /** this field's own metadata (label, kind, required, ...) — for a custom form that wants to
   * build its own `<label>`/layout around `.render()`'s output instead of using it as-is. */
  meta: ConsoleFieldMeta;
  /** the key `value`/`onChange` (passed to `.render()`) and the eventual save payload should use
   * for this field — `field.writeAs ?? field.key`. A `sensitive`+`writeAs` field (e.g. a
   * secret reported as `secretHash` with `writeAs: 'secret'`) submits under a different
   * key than its column name; every other field's `inputKey` is just its own `key`. */
  inputKey: string;
  /** renders this field's built-in editor — the same control the generated form uses (a
   * `reference`'s dropdown, `file`'s upload button, `manyToMany`'s multiselect, a `field.custom()`
   * registered against `FieldRenderersProvider`, ...) — so a custom form can reuse it inside its
   * own layout instead of reimplementing every field kind by hand. */
  render: (props: BoundFieldProps) => ReactNode;
}

/** `field.key` -> its bound renderer, one entry per field a form may actually submit — mirrors
 * the generated form's own field list (`ModelFormPage.tsx`): a field that's `sensitive` with no
 * `writeAs` is never round-tripped to the client at all, so it's left out here too. Built by
 * `createModelFieldRenderers`, and handed to a custom form as `ModelFormProps.fields`. */
export type ModelFieldRenderers = Record<string, BoundField>;

/** Binds every field/model-level constant `FieldInput` needs (`field`, `inputKey`, `modelName`,
 * `mode`) so a custom form's own `.render()` calls only ever have to supply what actually varies
 * per render: `value`, `onChange`, `error`, and (for an `actionRef`/`fieldRef` sub-field)
 * `formValues`/`formModel`. Exported standalone (not only reachable via `ModelFormProps.fields`)
 * for a custom page that isn't a model form at all — a bulk-edit dialog, say — but still wants the
 * same field editors. */
export function createModelFieldRenderers(model: ConsoleModelMeta, mode: 'create' | 'update'): ModelFieldRenderers {
  const renderers: ModelFieldRenderers = {};
  for (const f of model.fields) {
    if (f.sensitive && !f.writeAs) continue; // never writable through a declared key
    const inputKey = f.writeAs ?? f.key;
    renderers[f.key] = {
      meta: f,
      inputKey,
      render: (props) => <FieldInput field={f} inputKey={inputKey} modelName={model.name} mode={mode} {...props} />,
    };
  }
  return renderers;
}

/** Props a `<name>.form.tsx` component receives in place of the generated create/edit form —
 * see `ModelFormPage.tsx`, which renders it instead of its own field list once one is registered
 * for `model.name`. A custom form owns its data fetching/mutations entirely (via `getRow` /
 * `createRow` / `updateRow`, exported from `console/client`, the same helpers the generated form
 * itself uses) — there's no partial hand-off of just the field list, so a custom form isn't stuck
 * threading state through props it didn't design. */
export interface ModelFormProps {
  model: ConsoleModelMeta;
  mode: 'create' | 'update';
  /** the row id being edited; absent in create mode. */
  id?: string;
  /** call once the form is done — a successful save, or the user cancelling — same as the
   * generated form's own `onDone` (see `ModelFormPage.tsx`). Closes the dialog/returns to the
   * page it's layered over. */
  onDone: () => void;
  /** this model's fields, each already bound to its own built-in editor — `fields.email.render({
   * value, onChange })`, e.g., instead of rewiring `FieldInput` by hand for every field kind. */
  fields: ModelFieldRenderers;
  /** every model's console metadata (the same list `useModels()` exposes) — handed down so a
   * custom form can enumerate other models without calling `useModels()` itself. That matters for
   * the framework's own builtin forms (e.g. `Role`'s, which renders a permission tree across every
   * resource): a builtin form is imported via a package subpath and can end up in a *separate*
   * module graph from the app's `ModelsProvider`, so reaching for the context there would read a
   * second, provider-less `ModelsContext` instance and throw. Consuming `<name>.form.tsx` files
   * are always bundled into the app's own console graph, so they may use `useModels()` directly —
   * this prop just guarantees the builtins work either way. */
  models: ConsoleModelMeta[];
}

export type ModelFormComponent = ComponentType<ModelFormProps>;

const CustomFormsContext = createContext<Record<string, ModelFormComponent>>({});

export function CustomFormsProvider({
  forms,
  children,
}: {
  forms: Record<string, ModelFormComponent>;
  children: ReactNode;
}) {
  return <CustomFormsContext.Provider value={forms}>{children}</CustomFormsContext.Provider>;
}

export function useCustomForms(): Record<string, ModelFormComponent> {
  return useContext(CustomFormsContext);
}
