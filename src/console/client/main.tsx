import { createRoot } from 'react-dom/client';
import { ConsoleApp } from './ConsoleApp.js';
// Neither `ratchet:*` specifier below is a real package — a Bun.build plugin
// (`ratchetVirtualModulesPlugin`, src/cli/build-console.ts) resolves each to the consuming
// project's own generated file (built by `ratchet generate` from every `models/**/*.form.tsx`/
// `*.input.tsx`, see scan-forms.ts/forms-gen.ts and scan-field-inputs.ts/field-inputs-gen.ts).
// Those are the only consumer-facing extension points `ConsoleApp` has, so this entry —
// otherwise a fixed, per-app-identical shell — still lives in the framework rather than being
// consumer-authored.
import { customForms } from 'ratchet:custom-forms';
import { fieldInputs } from 'ratchet:field-inputs';
import { consolePlugins } from 'ratchet:plugins';

// keep the browser tab title in sync with the configured brand (same fallback as `BrandMark`) —
// the server shell ships a static "Ratchet console" `<title>` since brand is a client-bundle-only
// config (`ratchet.config.ts`'s `brand`), so it's applied here once the bundle loads.
document.title = __CONSOLE_BRAND__.name ?? 'Ratchet console';

const root = document.getElementById('root')!;
createRoot(root).render(<ConsoleApp customForms={customForms} fieldInputs={fieldInputs} plugins={consolePlugins} />);
