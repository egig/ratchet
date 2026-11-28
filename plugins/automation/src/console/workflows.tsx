import type { ConsolePlugin } from '@egig/ratchet/console/client';
import { WorkflowsPage } from './WorkflowsPage.js';

/** Workflows' console UI — the editor replaces the generic list screen of the `workflows` model
 * (plugin routes match before the console's `:model/*`). */
const workflowsConsole: ConsolePlugin = {
  name: 'automation-workflows',
  routes: [
    { path: 'workflows', element: <WorkflowsPage /> },
    { path: 'workflows/:workflowId', element: <WorkflowsPage /> },
  ],
};

export default workflowsConsole;
