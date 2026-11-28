export { ConsoleApp } from './ConsoleApp.js';
export type { ConsoleAppProps } from './ConsoleApp.js';
export type { FieldRenderer } from './field-renderers.js';
export { FieldInput } from './fields.js';
export type { FieldInputProps } from './fields.js';
export type { FieldInputOverrides } from './field-input-overrides.js';

// The surface a `<name>.form.tsx` (see docs/guide/console.md) authors against: `ModelFormProps`
// is the props shape it receives (including `fields`, its per-field bound renderers — call
// `fields[name].render({ value, onChange, ... })` instead of wiring `FieldInput` up by hand), and
// the rest are what the generated form itself uses to fetch the row, save it, and render those
// same field editors — reused here rather than making a custom form reinvent them.
export type { ModelFormProps, ModelFormComponent, ModelFieldRenderers, BoundField, BoundFieldProps } from './custom-forms.js';
export { createModelFieldRenderers } from './custom-forms.js';
export { useModels } from './models.js';
export { useAuth } from './auth.js';
export type { AuthUser, OffsetPage } from './api.js';
export { getRow, createRow, updateRow, listRows, callOperation, hasPermission, ApiRequestError } from './api.js';

// The plugin console contract — what a `RatchetPlugin.console` module default-exports, plus the
// shell pieces a plugin page reuses. See plugins.tsx.
export type { ConsolePlugin, ConsolePanel, WorkspacePanelProps } from './plugins.js';
export { useConsolePlugins } from './plugins.js';
// The console's own router (router.tsx) — plugin console pages navigate with these, not with
// `react-router`, which the console no longer runs on.
export { Link, NavLink, Navigate, Outlet, useNavigate, useParams, useLocation, useSearchParams } from './router.js';
export type { Location, To, NavigateOptions, NavigateFunction, Params, LinkProps, NavLinkProps, SetSearchParams } from './router.js';
export { queryKeys } from './query-keys.js';
export { Dialog as ModalDialog } from './Dialog.js';
export * from './icons.js';
export { apiRequest } from './api.js';
export type { ConsoleModelMeta, ConsoleFieldMeta, ConsoleOperationMeta } from '../serialize-model.js';

// **Experimental**: the console's own UI primitive layer (`ui/index.ts` — Radix Primitives
// restyled onto the token-based light/dark theme in styles.css, with `class-variance-authority`
// variants). Exported so a `*.form.tsx`/`*.input.tsx` can match the console's own look instead of
// reinventing buttons/inputs from scratch, but only `Button`/`Input`/`Label`/`Dialog` exist so far
// and their props may still change shape as the rest of the console migrates onto them — pin your
// `@egig/ratchet` version if you depend on this today.
export * from './ui/index.js';
