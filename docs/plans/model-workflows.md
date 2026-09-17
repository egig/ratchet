# Model workflows implementation plan

Status: planning complete for initial scope; implementation has not started.

## Agreed scope

- React Flow editor in Console → Automation, with a central workflow list.
- Automatic create/update/remove triggers after commit, plus manual runs.
- Durable background execution through managed Inngest initially. Isolate engine integration behind an adapter and expose endpoint/credential configuration for future self-hosted Inngest.
- Nodes: triggers, read/query records, create/update/remove records, custom model operations, if/else, and For each.
- Typed field references and literal values; structured condition operators. No user expressions or JavaScript.
- Forward-only graphs with one level of For each; no nested loops or backward edges.
- Parallel loop iterations with bounded concurrency, independent retries, per-item results, and explicit success/partial-failure outputs.
- Recovery retries failed items only, preserving the original version and captured inputs and resuming from failed steps. Successful work remains checkpointed.
- Draft editing, validation on publish, immutable published versions. Manual draft runs execute real actions and must be clearly labeled.
- Dedicated service identity and automation role per workflow. Enforce model, field, and ownership permissions at execution time. The triggering user is audit context, not the execution identity.
- Separate permissions for viewing runs, editing drafts, publishing, and manual execution. Role assignment requires grant authority; administrators receive management access by default.
- Event snapshots: before/after and changed fields for updates, after for creates, before for removals. Query nodes explicitly read current data.
- Workflow writes may trigger other workflows. Propagate chain identity, reject repeated workflow IDs within a chain, and enforce maximum chain depth.

## Architecture

Keep graph semantics, node contracts, versions, permissions, event envelopes, and application-facing run records in Ratchet. React Flow positions and viewport are editor metadata, not execution semantics. Persist a canonical graph with stable node IDs and typed input references.

Create a focused workflow module, proposed as `src/workflows/`, separate from existing AI chat automation implementation. Add console pages under `src/console/client/` and mount its dedicated router in `src/server/index.ts` before generic model routes. Expose workflow engine configuration through application options and the existing configuration/codegen path.

The execution adapter supplies durable steps, bounded iteration scheduling, checkpoint/recovery integration, run dispatch, and engine status translation. Inngest-specific types and credentials remain in its adapter. Implement only Inngest initially; a second engine is future work, not a promised configuration-only switch. Self-hosting the same engine should preserve definitions and action handlers, but migration of in-flight runs requires a separate operational procedure.

Proposed persisted entities: workflow draft/configuration, immutable workflow version, execution identity, model event/outbox entry, workflow run, and step/iteration projection with recovery lineage. Inngest owns execution checkpoints; Ratchet's projections support authorized console inspection and recovery selection without becoming a second scheduler.

Capture the model event and an outbox entry in the same database transaction as the model mutation. Dispatch after commit through a retryable delivery process. A durable scheduled sweep must recover undelivered entries even if the request crashes; specify how it is hosted for each supported deployment. Never rely solely on fire-and-forget request work. Deduplicate deliveries and run creation with stable event/version identifiers. Pin eligible published versions when scheduling event work so delayed delivery cannot silently select a newer definition.

Reuse existing model operations and permission checks through a shared authorized operation executor. Inspect `src/core/pipeline.ts`, `src/router/create-router.ts`, and `src/automation/tool.ts` before choosing that seam. Capture mutation events at the shared persistence/transaction boundary, covering supported router, agent, and workflow paths. Direct external SQL writes are outside v1 capture. Define custom-operation writes and implicit relation writes explicitly during implementation so events reflect actual mutations rather than only operation names.

## Execution semantics

- Validate node types, model/operation references, field types, branch structure, reachability, and cycles before publishing. Recheck current authorization and schema compatibility at execution.
- Data references must be available on every path reaching their consumer. Branch merges require defined input availability; parallel completion order must not determine output order.
- For each captures a bounded input list once, with stable iteration keys and deterministic result ordering. Oversized results produce an explicit limit error rather than silent truncation.
- Each iteration checkpoints its steps independently. Success and partial-failure outputs expose structured successful results and item errors. An unconnected partial-failure output terminates with partial-failure status.
- Recovery is linked to the original run and preserves its version, captured inputs, and successful checkpoints. It must not silently rerun downstream actions already executed on the partial-failure branch. Initial v1 proposal: recovery repairs failed iterations and reports its own aggregate result; continuing downstream requires an explicit action. Confirm this detail before implementing recovery UI.
- Role revocation takes effect on subsequent execution and recovery. Event snapshots and node outputs must obey field grants and run-view permissions; secret fields must not leak into the editor, event payloads, or logs.
- Use stable effect keys for writes. For database-only mutations, record effect completion atomically with the write where possible. Custom operations with external effects need their own idempotency contract; do not claim generic exactly-once execution.
- Chain metadata follows all workflow-originated mutations, including loop actions and recovery. Repeated workflow suppression is based on workflow identity, not version identity, and is visible in diagnostics.

## Implementation phases

### 1. Verify integration and define contracts

Build a small managed Inngest integration spike using a stored graph, branch, bounded parallel iteration, interrupted step, and failed-item recovery. Assess Workflow Kit's actual branching and recovery capabilities before adopting it; a Ratchet interpreter over Inngest steps remains an option. Verify endpoint mounting, request verification, local development, and build/runtime compatibility for Bun and the repository's Vercel/Cloudflare deployment paths. Record any unsupported target explicitly.

Define graph schemas, node-handler contracts, adapter capabilities, execution identity, permission resources, error/status vocabulary, and configurable limits. Select conservative documented defaults for item count, concurrency, retry policy, chain depth, and payload size after the spike; these numerical defaults have not been agreed yet.

### 2. Reliable event delivery and authorization

Add workflow/version/outbox/run persistence and migrations. Implement shared authorized action execution and transactionally captured events. Add retryable outbox delivery, duplicate suppression, version pinning, and chain guards. Support an initial vertical slice: record created → condition → update another record, executed by managed Inngest with a visible run result.

### 3. Complete execution and recovery

Add read/query and custom-operation nodes, typed mapping resolution, branches, bounded parallel For each, step/result projections, partial-failure outputs, and failed-item recovery. Implement and document write idempotency boundaries and permission checks on resumed work.

### 4. React Flow console

Build workflow list, node palette, canvas, node inspector, field picker, trigger settings, role assignment, draft persistence, publish validation, and manual-run input forms. Add run details with node status, authorized inputs/outputs, loop-item errors, and recovery controls. Expose graph limits and errors clearly. Keep management permissions separate from execution grants.

### 5. Deployment and verification

Document managed credentials, signing/verification, dispatch/sweep deployment, development setup, limits, and future self-host endpoint configuration. Verify restart recovery, event delivery, and authorization across supported deployment examples before claiming support. Provide an example workflow exercising a branch and a parallel loop with a recoverable failure.

## Acceptance checks

- A rolled-back mutation emits no event; a committed mutation remains deliverable after a request crash.
- Duplicate delivery creates no duplicate logical run. A committed database effect is not duplicated by a step retry.
- Editing/publishing during a run does not change its graph or captured inputs.
- Model-event and manual paths enforce the automation role, field restrictions, and ownership scope; unauthorized users cannot assign a stronger role or publish/run workflows.
- Snapshot conditions correctly detect old/new values, including deletions; protected fields remain inaccessible.
- A loop honors concurrency and item limits, continues after item failures, produces stable result ordering, and routes partial failure correctly.
- Recovery skips successful items and completed steps and does not replay previously executed downstream effects.
- Workflow cycles across model events terminate under chain guards; independent later events remain eligible.
- Invalid graphs, missing operations, incompatible mappings, and revoked permissions produce understandable errors.
- Run appropriate unit/integration tests plus project typecheck and build; manually verify the editor and representative execution/recovery flow.

## Deferred

Visual editing of model operation pipelines; general AI workflow composition; invoking existing AI agents as nodes; HTTP integrations; delay/wait nodes; schedules and webhook triggers; calculated expressions/user code; nested loops and backward graph connections; production self-host deployment and migration; additional engine adapters.

## Sources consulted

- React Flow: https://reactflow.dev/
- Inngest user-defined workflows: https://www.inngest.com/docs/guides/user-defined-workflows
- Inngest Workflow Kit: https://www.inngest.com/docs/reference/workflow-kit
- Inngest execution model: https://www.inngest.com/docs/learn/how-functions-are-executed
- Workflow SDK Postgres alternative: https://workflow-sdk.dev/worlds/postgres
