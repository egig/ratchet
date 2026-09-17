import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  type NodeProps,
  type Node as FlowNode,
} from '@xyflow/react';
import { defaultGraph, type Binding, type Graph, type WorkflowNode } from '../../workflows/graph.js';
import type { ConsoleFieldMeta, ConsoleModelMeta } from '../serialize-model.js';
import { Button } from './ui/button.js';

type Workflow = {
  id: string;
  name: string;
  draft: Graph;
  roleId?: string;
  publishedVersionId?: string;
  enabled: boolean;
};
type Meta = {
  models: ConsoleModelMeta[];
  roles: { id: string; name: string }[];
  permissions: Record<string, boolean>;
  limits: { concurrency: number; items: number };
};
type Run = {
  id: string;
  status: string;
  createdAt: string;
  error?: string;
  steps?: { id: string; key: string; status: string; error?: string; label?:string; output?:unknown }[];
};
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api/workflows${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json().catch(() => ({ error: { message: 'Workflows are unavailable. Configure the workflow adapter and apply migrations.' } }));
  if (!r.ok)
    throw new Error(
      data.error?.message ??
        'Workflows are unavailable. Configure the workflow adapter and apply migrations.',
    );
  return data;
}
const control = 'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm';
const kinds: WorkflowNode['kind'][] = [
  'query',
  'read',
  'create',
  'update',
  'remove',
  'operation',
  'condition',
  'foreach',
];
function WorkflowCard({ data }: NodeProps<FlowNode<{ node: WorkflowNode }>>) {
  const n = data.node;
  const ports =
    n.kind === 'condition' ? ['true', 'false'] : n.kind === 'foreach' ? ['success', 'partial'] : ['next'];
  return (
    <div className="min-w-40 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm">
      {n.kind !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="text-xs uppercase text-muted-foreground">
        {n.kind === 'foreach' ? 'For each' : n.kind}
      </div>
      <div className="font-medium">{n.label}</div>
      <div className="text-xs text-muted-foreground">{n.model}</div>
      {ports.map((p, i) => (
        <div key={p}>
          <Handle
            type="source"
            id={p}
            position={Position.Right}
            style={{ top: `${((i + 1) * 100) / (ports.length + 1)}%` }}
          />
          <span className="mr-2 text-[10px] text-muted-foreground">{p}</span>
        </div>
      ))}
    </div>
  );
}
const nodeTypes = { workflow: WorkflowCard };

function BindingInput({
  value,
  onChange,
  options,
  field,
}: {
  value?: Binding;
  onChange: (b: Binding | undefined) => void;
  options: { label: string; source: string; path: string[] }[];
  field?: ConsoleFieldMeta;
}) {
  const reference = value?.kind === 'ref';
  const [literalType, setLiteralType] = useState('string');
  return (
    <div className="space-y-1">
      <select
        className={control}
        value={!value ? 'omit' : reference ? 'ref' : 'literal'}
        onChange={(e) =>
          onChange(
            e.target.value === 'omit'
              ? undefined
              : e.target.value === 'ref'
                ? { kind: 'ref', source: 'trigger', path: ['after', 'id'] }
                : {
                    kind: 'literal',
                    value: field?.kind === 'boolean' ? false : field?.kind === 'integer' ? 0 : '',
                  },
          )
        }
      >
        <option value="omit">Not set</option>
        <option value="literal">Fixed value</option>
        <option value="ref">Earlier step field</option>
      </select>
      {!field && value?.kind === 'literal' && (
        <select
          aria-label="Value type"
          className={control}
          value={typeof value.value === 'number' ? 'number' : literalType}
          onChange={(e) => {
            setLiteralType(e.target.value);
            onChange({ kind: 'literal', value: e.target.value === 'number' ? 0 : '' });
          }}
        >
          <option value="string">Text</option>
          <option value="number">Number</option>
        </select>
      )}
      {reference ? (
        <select
          className={control}
          value={JSON.stringify([value.source, value.path])}
          onChange={(e) => {
            const [source, path] = JSON.parse(e.target.value);
            onChange({ kind: 'ref', source, path });
          }}
        >
          <option value="">Choose a field</option>
          {options.map((o) => (
            <option key={JSON.stringify(o)} value={JSON.stringify([o.source, o.path])}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        value?.kind === 'literal' &&
        (field?.kind === 'boolean' ? (
          <select
            className={control}
            value={String(value.value)}
            onChange={(e) => onChange({ kind: 'literal', value: e.target.value === 'true' })}
          >
            <option>false</option>
            <option>true</option>
          </select>
        ) : field?.values ? (
          <select
            className={control}
            value={String(value.value)}
            onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
          >
            <option value="">Choose a value</option>
            {field.values.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        ) : (
          <input
            className={control}
            type={
              field?.kind === 'integer' ||
              (!field && (literalType === 'number' || typeof value.value === 'number'))
                ? 'number'
                : 'text'
            }
            value={String(value.value ?? '')}
            onChange={(e) =>
              onChange({
                kind: 'literal',
                value:
                  field?.kind === 'integer' ||
                  (!field && (literalType === 'number' || typeof value.value === 'number'))
                    ? Number(e.target.value)
                    : e.target.value,
              })
            }
          />
        ))
      )}
    </div>
  );
}
export function WorkflowsPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const meta = useQuery({ queryKey: ['workflow-meta'], queryFn: () => api<Meta>('/meta') });
  const list = useQuery({ queryKey: ['workflows'], queryFn: () => api<Workflow[]>('') });
  const detail = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => api<Workflow>(`/${workflowId}`),
    enabled: !!workflowId,
  });
  const [w, setW] = useState<Workflow>();
  const [selected, select] = useState('trigger');
  const [scope, setScope] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState('');
  const [recordId, setRecordId] = useState('');
  const [draftRun, setDraftRun] = useState(false);
  const [runId, setRunId] = useState<string>();
  const runs = useQuery({
    queryKey: ['workflow-runs', workflowId],
    queryFn: () => api<Run[]>(`/${workflowId}/runs`),
    enabled: !!workflowId && !!meta.data?.permissions.viewRuns,
    refetchInterval: 3000,
  });
  const run = useQuery({
    queryKey: ['workflow-run', runId],
    queryFn: () => api<Run>(`/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: 3000,
  });
  useEffect(() => {
    setW(detail.data);
    setDirty(false);
    setScope(undefined);
    select('trigger');
  }, [detail.data]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };
  const edit = (graph: Graph) => {
    if (w) {
      setW({ ...w, draft: graph });
      setDirty(true);
    }
  };
  const patch = (changes: Partial<WorkflowNode>) => {
    if (w)
      edit({ ...w.draft, nodes: w.draft.nodes.map((n) => (n.id === selected ? { ...n, ...changes } : n)) });
  };
  const save = async () => {
    if (!w) return;
    await api(`/${w.id}`, 'PATCH', { name: w.name, draft: w.draft, roleId: w.roleId });
    setDirty(false);
    await cache.invalidateQueries({ queryKey: ['workflows'] });
  };
  if (meta.error || list.error)
    return <div className="p-6 text-destructive">{(meta.error ?? list.error)?.message}</div>;
  if (!meta.data || !list.data) return <div className="p-6">Loading workflows…</div>;
  const perms = meta.data.permissions;
  if (!workflowId)
    return (
      <div className="space-y-5 p-6">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="text-muted-foreground">Automate model events with connected actions and conditions.</p>
        {message && <p role="alert">{message}</p>}
        {perms.edit && (
          <form
            className="flex max-w-lg gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const created = await api<Workflow>('', 'POST', { name: newName });
                await cache.invalidateQueries({ queryKey: ['workflows'] });
                navigate(`/workflows/${created.id}`);
              });
            }}
          >
            <input
              aria-label="Workflow name"
              className={control}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Workflow name"
              required
            />
            <Button type="submit" disabled={busy}>
              Create workflow
            </Button>
          </form>
        )}
        <div className="divide-y rounded-lg border">
          {list.data.map((x) => (
            <Link className="flex justify-between p-4 hover:bg-muted" key={x.id} to={`/workflows/${x.id}`}>
              <span>{x.name}</span>
              <span className="text-sm text-muted-foreground">
                {x.enabled ? 'Published · active' : 'Draft / paused'}
              </span>
            </Link>
          ))}
          {!list.data.length && (
            <p className="p-6 text-muted-foreground">Create your first model automation.</p>
          )}
        </div>
      </div>
    );
  if (!w) return <div className="p-6">{detail.error?.message ?? 'Loading workflow…'}</div>;
  const g = w.draft;
  const node = g.nodes.find((n) => n.id === selected);
  const model = meta.data.models.find((m) => m.name === node?.model);
  const options: { label: string; source: string; path: string[] }[] = [];
  const addFields = (source: string, prefix: string[], m?: ConsoleModelMeta) => {
    for (const key of ['id', ...(m?.fields.filter((f) => !f.sensitive).map((f) => f.key) ?? [])])
      options.push({ label: `${source}.${[...prefix, key].join('.')}`, source, path: [...prefix, key] });
  };
  addFields(
    'trigger',
    ['after'],
    meta.data.models.find((m) => m.name === g.trigger.model),
  );
  addFields(
    'trigger',
    ['before'],
    meta.data.models.find((m) => m.name === g.trigger.model),
  );
  const ancestors = new Set<string>();
  let previous = node?.id;
  while (previous) {
    const edge = g.edges.find((e) => e.target === previous);
    if (!edge || ancestors.has(edge.source)) break;
    ancestors.add(edge.source);
    previous = edge.source;
  }
  if (node?.parentId) {
    let p: string | undefined = node.parentId;
    while (p && !ancestors.has(p)) {
      ancestors.add(p);
      p = g.edges.find((e) => e.target === p)?.source;
    }
  }
  for (const n of g.nodes.filter((n) => ancestors.has(n.id))) {
    if (n.kind === 'query') {
      options.push(
        { label: `${n.label}.items`, source: n.id, path: ['items'] },
        { label: `${n.label}.count`, source: n.id, path: ['count'] },
      );
    } else if (n.kind === 'foreach')
      for (const key of ['results', 'failed', 'succeeded'])
        options.push({ label: `${n.label}.${key}`, source: n.id, path: [key] });
    else
      addFields(
        n.id,
        [],
        meta.data.models.find((m) => m.name === n.model),
      );
  }
  if (node?.parentId) {
    const parent = g.nodes.find((n) => n.id === node.parentId);
    const source = parent?.inputs.items;
    const query = source?.kind === 'ref' ? g.nodes.find((n) => n.id === source.source) : undefined;
    addFields(
      'item',
      [],
      meta.data.models.find((m) => m.name === query?.model),
    );
  }
  const fields =
    node?.kind === 'operation'
      ? (model?.operations.find((o) => o.name === node.operation)?.params ?? [])
      : (model?.fields.filter((f) => !f.sensitive) ?? []);
  const keys =
    node?.kind === 'condition'
      ? ['left', 'right']
      : node?.kind === 'foreach'
        ? ['items']
        : node?.kind === 'read' || node?.kind === 'remove'
          ? ['id']
          : node?.kind === 'update' || node?.kind === 'operation'
            ? ['id', ...fields.map((f) => f.key)]
            : fields.map((f) => f.key);
  return (
    <div className="flex h-[calc(100vh-5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Link to="/workflows" className="text-sm">
          ← Workflows
        </Link>
        <input
          aria-label="Workflow name"
          className={`${control} max-w-60`}
          value={w.name}
          disabled={!perms.edit}
          onChange={(e) => {
            setW({ ...w, name: e.target.value });
            setDirty(true);
          }}
        />
        <span className="text-xs text-muted-foreground">
          {dirty ? 'Unsaved draft' : w.enabled ? 'Published · active' : 'Draft / paused'}
        </span>
        {perms.edit && (
          <Button disabled={busy} onClick={() => void perform(save)}>
            Save draft
          </Button>
        )}
        {perms.publish && (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (perms.edit) await save();
                  await api(`/${w.id}/publish`, 'POST');
                  await cache.invalidateQueries({ queryKey: ['workflow', w.id] });
                  setMessage('Published. New events use this version.');
                })
              }
            >
              Publish
            </Button>
            {w.publishedVersionId && (
              <Button
                variant="outline"
                onClick={() =>
                  void perform(async () => {
                    await api(`/${w.id}`, 'PATCH', { enabled: !w.enabled });
                    await cache.invalidateQueries({ queryKey: ['workflow', w.id] });
                  })
                }
              >
                {w.enabled ? 'Pause' : 'Activate'}
              </Button>
            )}
          </>
        )}
      </div>
      {message && (
        <p role="alert" className="border-b px-4 py-2 text-sm">
          {message}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 space-y-2 overflow-auto border-r p-3">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Add step</p>
          {kinds
            .filter((k) => !scope || k !== 'foreach')
            .map((kind) => (
              <button
                disabled={!perms.edit}
                key={kind}
                className="block w-full rounded border px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-40"
                onClick={() => {
                  const id = crypto.randomUUID();
                  edit({
                    ...g,
                    nodes: [
                      ...g.nodes,
                      {
                        id,
                        kind,
                        label: kind === 'foreach' ? 'For each' : kind,
                        position: { x: 150 + Math.random() * 100, y: 100 + Math.random() * 200 },
                        inputs: {},
                        ...(scope ? { parentId: scope } : {}),
                      },
                    ],
                  });
                  select(id);
                }}
              >
                {kind === 'foreach' ? 'For each' : kind}
              </button>
            ))}
          {scope && (
            <Button variant="outline" onClick={() => setScope(undefined)}>
              Back to main flow
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Connect an output handle to the next step. Select an edge and press Delete to remove it.
          </p>
        </aside>
        <main className="min-w-0 flex-1">
          <ReactFlow
            nodes={g.nodes
              .filter((n) => n.parentId === scope)
              .map((n) => ({
                id: n.id,
                type: 'workflow',
                position: n.position,
                data: { node: n },
                selected: n.id === selected,
              }))}
            edges={g.edges
              .filter((e) => g.nodes.find((n) => n.id === e.source)?.parentId === scope)
              .map((e) => ({
                id: `${e.source}:${e.port}`,
                source: e.source,
                target: e.target,
                sourceHandle: e.port,
                label: e.port,
              }))}
            nodeTypes={nodeTypes}
            nodesDraggable={perms.edit}
            nodesConnectable={perms.edit}
            onNodeClick={(_, n) => select(n.id)}
            onNodesChange={(changes) => {
              if (!perms.edit) return;
              const positions = applyNodeChanges(
                changes.filter((c) => c.type === 'position'),
                g.nodes.map((n) => ({ id: n.id, position: n.position, data: {} })),
              );
              if (changes.some((c) => c.type === 'position'))
                edit({
                  ...g,
                  nodes: g.nodes.map((n) => ({
                    ...n,
                    position: positions.find((p) => p.id === n.id)?.position ?? n.position,
                  })),
                });
            }}
            onEdgesDelete={(edges) =>
              perms.edit &&
              edit({
                ...g,
                edges: g.edges.filter((e) => !edges.some((x) => x.id === `${e.source}:${e.port}`)),
              })
            }
            onConnect={(c) => {
              if (c.source && c.target)
                edit({
                  ...g,
                  edges: [
                    ...g.edges,
                    {
                      source: c.source,
                      target: c.target,
                      port: (c.sourceHandle ?? 'next') as Graph['edges'][number]['port'],
                    },
                  ],
                });
            }}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </main>
        <aside className="w-80 shrink-0 space-y-4 overflow-auto border-l p-4">
          <fieldset disabled={!perms.edit} className="space-y-3">
            <label className="block text-sm">
              Automation role
              <select
                className={control}
                disabled={!perms.assignRole}
                value={w.roleId ?? ''}
                onChange={(e) => {
                  setW({ ...w, roleId: e.target.value });
                  setDirty(true);
                }}
              >
                <option value="">Choose role</option>
                {meta.data.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {node && (
              <>
                <label className="block text-sm">
                  Step label
                  <input
                    className={control}
                    value={node.label}
                    onChange={(e) => patch({ label: e.target.value })}
                  />
                </label>
                {node.kind === 'trigger' ? (
                  <>
                    <label className="block text-sm">
                      Event
                      <select
                        className={control}
                        value={g.trigger.event}
                        onChange={(e) =>
                          edit({
                            ...g,
                            trigger: { ...g.trigger, event: e.target.value as Graph['trigger']['event'] },
                          })
                        }
                      >
                        {['manual', 'create', 'update', 'remove'].map((e) => (
                          <option key={e}>{e}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      Trigger model
                      <select
                        className={control}
                        value={g.trigger.model}
                        onChange={(e) => edit({ ...g, trigger: { ...g.trigger, model: e.target.value } })}
                      >
                        <option value="">Choose model</option>
                        {meta.data.models.map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    {['query', 'read', 'create', 'update', 'remove', 'operation'].includes(node.kind) && (
                      <label className="block text-sm">
                        Model
                        <select
                          className={control}
                          value={node.model ?? ''}
                          onChange={(e) => patch({ model: e.target.value, inputs: {}, operation: undefined })}
                        >
                          <option value="">Choose model</option>
                          {meta.data.models.map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {node.kind === 'operation' && (
                      <select
                        aria-label="Operation"
                        className={control}
                        value={node.operation ?? ''}
                        onChange={(e) => patch({ operation: e.target.value, inputs: {} })}
                      >
                        <option value="">Choose operation</option>
                        {model?.operations.map((o) => (
                          <option key={o.name} value={o.name}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {node.kind === 'condition' && (
                      <select
                        aria-label="Condition operator"
                        className={control}
                        value={node.operator ?? ''}
                        onChange={(e) => patch({ operator: e.target.value as WorkflowNode['operator'] })}
                      >
                        <option value="">Choose operator</option>
                        {['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'exists'].map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    )}
                    {node.kind === 'foreach' && (
                      <>
                        <label className="block text-sm">
                          Concurrency
                          <input
                            className={control}
                            type="number"
                            min={1}
                            max={meta.data.limits.concurrency}
                            value={node.concurrency ?? meta.data.limits.concurrency}
                            onChange={(e) => patch({ concurrency: Number(e.target.value) })}
                          />
                        </label>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setScope(node.id);
                            select('');
                          }}
                        >
                          Edit loop body
                        </Button>
                      </>
                    )}
                    {keys.map((key) => (
                      <label className="block space-y-1 text-sm" key={key}>
                        <span>{fields.find((f) => f.key === key)?.label ?? key}</span>
                        <BindingInput
                          value={node.inputs[key]}
                          field={fields.find((f) => f.key === key)}
                          options={options}
                          onChange={(b) => {
                            const inputs = { ...node.inputs };
                            if (b) inputs[key] = b;
                            else delete inputs[key];
                            patch({ inputs });
                          }}
                        />
                      </label>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() => {
                        const removed = new Set([
                          node.id,
                          ...g.nodes.filter((n) => n.parentId === node.id).map((n) => n.id),
                        ]);
                        edit({
                          ...g,
                          nodes: g.nodes.filter((n) => !removed.has(n.id)),
                          edges: g.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
                        });
                        select('trigger');
                      }}
                    >
                      Delete step
                    </Button>
                  </>
                )}
              </>
            )}
          </fieldset>
          {perms.run && (
            <div className="space-y-2 border-t pt-3">
              <strong className="text-sm">Manual run</strong>
              <p className="text-xs text-muted-foreground">
                Runs perform real actions using the automation role.
              </p>
              <input
                aria-label="Trigger record ID"
                className={control}
                placeholder="Trigger record ID"
                value={recordId}
                onChange={(e) => setRecordId(e.target.value)}
              />
              <label className="flex gap-2 text-sm">
                <input type="checkbox" checked={draftRun} onChange={(e) => setDraftRun(e.target.checked)} />
                Test saved draft
              </label>
              <Button
                disabled={busy || dirty}
                onClick={() =>
                  void perform(async () => {
                    const r = await api<Run>(`/${w.id}/run`, 'POST', {
                      draft: draftRun,
                      recordId: recordId || undefined,
                    });
                    setRunId(r.id);
                    setMessage('Run queued. The dispatcher picks it up within a minute.');
                  })
                }
              >
                Run workflow
              </Button>
            </div>
          )}
        </aside>
      </div>
      {perms.viewRuns && (
        <section className="max-h-52 overflow-auto border-t p-3">
          <div className="flex gap-4">
            <div className="w-72 shrink-0">
              <strong className="text-sm">Recent runs</strong>
              {runs.data?.map((r) => (
                <button
                  className="block w-full truncate py-1 text-left text-xs"
                  key={r.id}
                  onClick={() => setRunId(r.id)}
                >
                  {r.status} · {r.createdAt}
                </button>
              ))}
            </div>
            {run.data && (
              <div className="flex-1 space-y-1 text-xs">
                <strong>{run.data.status}</strong>
                {run.data.error && <p>{run.data.error}</p>}
                {run.data.steps?.map((s) => (
                  <p key={s.id}>
                    {s.label ?? s.key.split(':').slice(1).join(':')} · {s.status}
                    {s.error && ` · ${s.error}`}
                  </p>
                ))}
                {perms.run && ['failed', 'partial'].includes(run.data.status) && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const r = await api<Run>(`/runs/${run.data!.id}/retry`, 'POST');
                        setRunId(r.id);
                      })
                    }
                  >
                    Retry failed work
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
