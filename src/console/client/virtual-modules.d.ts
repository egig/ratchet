// Declares brand-new ambient modules (not augmentations of real ones) — that only works from a
// file with no top-level import/export of its own (a "global" .d.ts), which is the entire reason
// these live in their own file instead of alongside the (very similar) __CONSOLE_PATH__ /
// __CONSOLE_BRAND__ declarations in env.d.ts: that file's top-level `import type` (needed for
// `ConsoleBrandConfig`) makes it a module, and a `declare module '...'` block placed there would
// only be visible within env.d.ts itself, not from `main.tsx`/`fields.tsx`.

/** Not a real package — a `Bun.build` plugin (`ratchetVirtualModulesPlugin`,
 * src/cli/build-console.ts) resolves this specifier to the consuming project's generated
 * `<generatedDir>/console-forms.ts` (see forms-gen.ts) at bundle time. Declared here purely so
 * `main.tsx`'s `import` of it typechecks against *some* shape — the generated file's real shape
 * is checked independently (it's plain TypeScript, not this ambient stand-in). */
declare module 'ratchet:custom-forms' {
  import type { ModelFormComponent } from './custom-forms.js';
  export const customForms: Record<string, ModelFormComponent>;
}

/** Same idea, for the consuming project's generated `<generatedDir>/console-field-inputs.ts` (see
 * field-inputs-gen.ts) — also imported by `main.tsx`, which passes it to `<ConsoleApp
 * fieldInputs={...} />`; `fields.tsx` itself only ever reads it back out through
 * `useFieldInputOverrides()` (field-input-overrides.tsx), same as `customForms` reaches
 * `ModelFormPage` through context rather than a direct import. */
declare module 'ratchet:field-inputs' {
  import type { FieldRenderer } from './field-renderers.js';
  export const fieldInputs: Record<string, Record<string, FieldRenderer>>;
}

/** Same idea, for the generated `<generatedDir>/console-plugins.ts` (console-plugins-gen.ts) —
 * every enabled plugin's console module, passed to `<ConsoleApp plugins={...} />`. */
declare module 'ratchet:plugins' {
  import type { ConsolePlugin } from './plugins.js';
  export const consolePlugins: ConsolePlugin[];
}
