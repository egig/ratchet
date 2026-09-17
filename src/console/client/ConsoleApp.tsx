import { WorkflowsPage } from './WorkflowsPage.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider } from './auth.js';
import { RequireAuth } from './RequireAuth.js';
import { Layout } from './Layout.js';
import { LoginPage } from './LoginPage.js';
import { SetupPage } from './SetupPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { IndexRedirect } from './IndexRedirect.js';
import { ModelListPage } from './ModelListPage.js';
import { SettingsPage } from './SettingsPage.js';
import { ProfilePage } from './ProfilePage.js';
import { WorkspacePage } from './WorkspacePage.js';
import { CustomFormsProvider, type ModelFormComponent } from './custom-forms.js';
import { FieldInputOverridesProvider, type FieldInputOverrides } from './field-input-overrides.js';

// One client for the whole SPA lifetime — `ConsoleApp` is mounted once by `main.tsx`, so this
// never needs to be recreated per-render. Retries off: a failed request here is almost always an
// auth/permission/validation error a retry won't fix, and `ApiRequestError` carries the server's
// own `{ code, fields }` for the caller to act on immediately instead of after a delay.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export interface ConsoleAppProps {
  /** name -> component, one entry per `<name>.form.tsx` under `modelsDir` (see `scan-forms.ts`,
   * `forms-gen.ts`) — `ModelFormPage` renders the matching one instead of the generated form.
   * Built by the generated `console-forms.ts` and passed in by `console/client/main.tsx`; every
   * other caller (e.g. a test rendering `<ConsoleApp />` directly) gets none, same as before this
   * prop existed. */
  customForms?: Record<string, ModelFormComponent>;
  /** modelName -> fieldKey -> renderer, one entry per `<model>.<field>.input.tsx` under
   * `modelsDir` (see `scan-field-inputs.ts`, `field-inputs-gen.ts`) — `FieldInput` (fields.tsx)
   * renders the matching one instead of its own kind-based switch. Built by the generated
   * `console-field-inputs.ts` and passed in by `console/client/main.tsx`. */
  fieldInputs?: FieldInputOverrides;
}

/** The console SPA's root — every deployment gets the same shell (routes, sidebar, list/table
 * views) except for branding (`ratchet.config.ts`'s `brand`, see `BrandMark.tsx`), per-model
 * create/edit forms (`customForms`), and per-field inputs (`fieldInputs`), all build-time config.
 * Mounted by `console/client/main.tsx`. */
export function ConsoleApp({ customForms, fieldInputs }: ConsoleAppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <CustomFormsProvider forms={customForms ?? {}}>
        <FieldInputOverridesProvider overrides={fieldInputs ?? {}}>
          <BrowserRouter basename={__CONSOLE_PATH__}>
            <AuthProvider>
              <Routes>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireAuth />}>
                  <Route path="workspace/:workspaceId/*" element={<WorkspacePage />} />
                  <Route path="profile" element={<ProfilePage />} />
                  <Route element={<Layout />}>
                    <Route index element={<IndexRedirect />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="settings/:domain" element={<SettingsPage />} />
                    <Route path="workflows" element={<WorkflowsPage />} />
                    <Route path="workflows/:workflowId" element={<WorkflowsPage />} />
                    <Route path=":model/*" element={<ModelListPage />} />
                  </Route>
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </AuthProvider>
          </BrowserRouter>
        </FieldInputOverridesProvider>
      </CustomFormsProvider>
    </QueryClientProvider>
  );
}
