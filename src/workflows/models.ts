import { defineModel } from '../core/model.js';
import { field } from '../core/field.js';
const internal = { console: { hidden: true }, api: { hidden: true } };
const action = () => {
  throw new Error('Use the workflow API');
};
export const Workflow = defineModel('workflows', {
  ...internal,
  console: { label: 'Workflows' },
  fields: {
    name: field.string({ required: true }),
    draft: field.json(),
    roleId: field.reference('roles'),
    serviceId: field.string(),
    publishedVersionId: field.string(),
    enabled: field.boolean({ default: false }),
  },
  operations: { edit: action, publish: action, run: action, assignRole: action, viewRuns: action },
});
export const WorkflowVersion = defineModel('workflow_versions', {
  ...internal,
  fields: {
    workflowId: field.reference('workflows'),
    graph: field.json(),
    roleId: field.string(),
    serviceId: field.string(),
  },
});
export const WorkflowRun = defineModel('workflow_runs', {
  ...internal,
  fields: {
    workflowId: field.reference('workflows'),
    versionId: field.string(),
    status: field.string(),
    payload: field.json(),
    recoveryOf: field.string(),
    error: field.text(),
  },
});
export const WorkflowStep = defineModel('workflow_steps', {
  ...internal,
  fields: {
    runId: field.reference('workflow_runs'),
    key: field.string({ unique: true }),
    status: field.string(),
    output: field.json(),
    error: field.text(),
  },
});
export const WorkflowOutbox = defineModel('workflow_outbox', {
  ...internal,
  fields: { runId: field.reference('workflow_runs'), delivered: field.boolean({ default: false }) },
});
export const workflowModels = [Workflow, WorkflowVersion, WorkflowRun, WorkflowStep, WorkflowOutbox];
