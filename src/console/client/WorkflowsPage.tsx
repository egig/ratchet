import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useInternalNode,
  useReactFlow,
  type NodeProps,
  type NodePositionChange,
  type Node as FlowNode,
} from '@xyflow/react';
import { BUILTIN_ACTIONS, type BuiltinAction, type Binding, type Graph, type WorkflowNode } from '../../workflows/graph.js';
import type { ConsoleFieldMeta, ConsoleModelMeta } from '../serialize-model.js';
import { Button } from './ui/button.js';
import { WorkflowButtonHandle } from './WorkflowButtonHandle.js';
import { WorkflowNodePopover } from './WorkflowNodePopover.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog.js';
import {
  PlusIcon,
  BoltIcon,
  MagnifyingGlassIcon,
  EyeIcon,
  PlusCircleIcon,
  EditIcon,
  TrashIcon,
  ToolIcon,
  BranchIcon,
  LoopIcon,
} from './icons.js';
import type { ComponentType, SVGProps } from 'react';

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
type StepKind = Exclude<WorkflowNode['kind'], 'trigger'>;
type Port = Graph['edges'][number]['port'];
const stepTypes: { kind: StepKind; label: string; description: string }[] = [
  { kind: 'model', label: 'Model Operation', description: 'Query, read, or change a record' },
  { kind: 'condition', label: 'Condition', description: 'Branch on a comparison' },
  { kind: 'foreach', label: 'For each', description: 'Repeat steps for each item' },
];
const NO_PORTS: Port[] = [];
const BUILTIN_OPERATIONS: { name: BuiltinAction; label: string }[] = [
  { name: 'query', label: 'Query' },
  { name: 'read', label: 'Read' },
  { name: 'create', label: 'Create' },
  { name: 'update', label: 'Update' },
  { name: 'remove', label: 'Remove' },
];
const BUILTIN_OPERATION_ICONS: Record<BuiltinAction, ComponentType<SVGProps<SVGSVGElement>>> = {
  query: MagnifyingGlassIcon,
  read: EyeIcon,
  create: PlusCircleIcon,
  update: EditIcon,
  remove: TrashIcon,
};
function nodeIcon(n: WorkflowNode): ComponentType<SVGProps<SVGSVGElement>> {
  if (n.kind === 'trigger') return BoltIcon;
  if (n.kind === 'condition') return BranchIcon;
  if (n.kind === 'foreach') return LoopIcon;
  return BUILTIN_OPERATION_ICONS[n.operation as BuiltinAction] ?? ToolIcon;
}

function WorkflowCard({ data }: NodeProps<FlowNode<{
  node: WorkflowNode;
  onEdit: (nodeId: string) => void;
  onAdd: (nodeId: string, port: Port) => void;
  connectedPorts: Port[];
  canEdit: boolean;
  loopStart: boolean;
}>>) {
  const n = data.node;
  const ports: Port[] =
    n.kind === 'condition' ? ['true', 'false'] : n.kind === 'foreach' ? ['success', 'partial'] : ['next'];
  const Icon = data.loopStart ? LoopIcon : nodeIcon(n);
  const kindLabel =
    n.kind === 'foreach' ? 'For each' : n.kind === 'model' ? (n.operation ?? 'Model Operation') : n.kind;
  return (
    <div className="min-w-40 rounded-lg border border-border bg-surface p-3 text-foreground shadow-md">
      {n.kind !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-1.5 text-xs uppercase text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{data.loopStart ? 'Loop body' : kindLabel}</span>
      </div>
      {data.loopStart ? (
        <div className="font-medium">{n.label}</div>
      ) : (
        <button
          className="nodrag block text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit ${n.label}`}
          aria-haspopup="dialog"
          onClick={() => data.onEdit(n.id)}
        >
          {n.label}
        </button>
      )}
      <div className="text-xs text-muted-foreground">{n.model}</div>
      {ports.map((p, i) => (
        <div key={p}>
          <WorkflowButtonHandle
            port={p}
            top={`${((i + 1) * 100) / (ports.length + 1)}%`}
            showButton={data.canEdit && !data.connectedPorts.includes(p)}
            onAdd={() => data.onAdd(n.id, p)}
          />
          <span className="mr-2 text-[10px] text-muted-foreground">{p}</span>
        </div>
      ))}
    </div>
  );
}
const nodeTypes = { workflow: WorkflowCard };

function FocusNewStep({ nodeId, onDone }: { nodeId?: string; onDone: () => void }) {
  const node = useInternalNode(nodeId ?? '');
  const { setCenter, getZoom } = useReactFlow();
  useEffect(() => {
    if (!nodeId || !node?.measured.width || !node.measured.height) return;
    void setCenter(
      node.internals.positionAbsolute.x + node.measured.width / 2,
      node.internals.positionAbsolute.y + node.measured.height / 2,
      { zoom: Math.min(getZoom(), 1), duration: 200 },
    );
    onDone();
  }, [nodeId, node, setCenter, getZoom, onDone]);
  return null;
}

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
  const [focusStep, setFocusStep] = useState<string>();
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [addingStep, setAddingStep] = useState<{ sourceId: string; port: Port }>();
  const canvasRef = useRef<HTMLElement>(null);
  // Stable across renders (state setters never change identity) so every node's `data.onAdd`/
  // `data.onEdit` prop stays referentially equal — otherwise every node's `data` object would look
  // "changed" to @xyflow/react on every render (e.g. each drag tick), defeating its internal
  // per-node memoization and re-rendering the whole canvas (visible as a flicker) instead of just
  // the node actually being dragged.
  const handleAddPort = useCallback(
    (nodeId: string, port: Port) => {
      select(nodeId);
      setNodeEditorOpen(false);
      setAddingStep({ sourceId: nodeId, port });
    },
    [],
  );
  const handleEditNode = useCallback((nodeId: string) => {
    setAddingStep(undefined);
    select(nodeId);
    setNodeEditorOpen(true);
  }, []);
  // Grouped once per render, and stable across drag-only updates (edges don't change while
  // dragging a node) — see the comment above `handleAddPort` for why stability here matters.
  const connectedPortsByNode = useMemo(() => {
    const map = new Map<string, Port[]>();
    for (const e of w?.draft.edges ?? []) {
      const arr = map.get(e.source);
      if (arr) arr.push(e.port);
      else map.set(e.source, [e.port]);
    }
    return map;
  }, [w?.draft.edges]);
  // @xyflow/react's `adoptUserNodes` decides whether a node needs reprocessing by comparing the
  // exact object reference we hand it in `nodes` (`userNode === internalNode.internals.userNode`,
  // `checkEquality: true` by default) — not a deep/field comparison. Handing it a fresh `{ id,
  // position, data, ... }` literal every render (as a plain `.map()` would) fails that check for
  // *every* node on *every* render, so it rebuilds the node's internal record from scratch —
  // including resetting `measured` to `{ width: undefined, height: undefined }` since our literal
  // has no `measured` field — which is treated as "not yet measured" until the next
  // ResizeObserver tick. That unmeasured flash, repeating on every render during a drag, is the
  // blink. This cache hands back the *same* object for a node whose relevant inputs haven't
  // changed, so unrelated/unmoved nodes are left alone.
  const flowNodeCache = useRef(
    new Map<
      string,
      { n: WorkflowNode; canEdit: boolean; loopStart: boolean; connectedPorts: Port[]; selected: boolean; flow: FlowNode }
    >(),
  ).current;
  // The node actually being dragged legitimately gets a new `n` (its position changes every
  // pointer-move, in controlled mode we're the only thing moving it — xyflow's `triggerNodeChanges`
  // only writes back into its own store when using `useNodesState`'s `defaultNodes`, not a
  // `nodes`-prop-controlled flow like this one), so it can't reuse the cache above and rebuilds
  // every tick regardless. Without `measured` on that rebuilt object, `adoptUserNodes` (see the
  // comment above) resets it to `{ width: undefined, height: undefined }` on every tick, which is
  // what was still blinking. Reapplying the last known `dimensions` from `onNodesChange` (captured
  // below) keeps it "measured" across every rebuild.
  const measuredByNode = useRef(new Map<string, { width?: number; height?: number }>()).current;
  function buildFlowNode(n: WorkflowNode, isLoopStart: boolean): FlowNode {
    const canEdit = !!perms.edit;
    const connectedPorts = connectedPortsByNode.get(n.id) ?? NO_PORTS;
    const isSelected = n.id === selected;
    const cached = flowNodeCache.get(n.id);
    if (
      cached &&
      cached.n === n &&
      cached.canEdit === canEdit &&
      cached.loopStart === isLoopStart &&
      cached.connectedPorts === connectedPorts &&
      cached.selected === isSelected
    ) {
      return cached.flow;
    }
    const flow: FlowNode = {
      id: n.id,
      type: 'workflow',
      position: n.position,
      measured: measuredByNode.get(n.id),
      draggable: !isLoopStart && canEdit,
      connectable: !isLoopStart && canEdit,
      data: { node: n, canEdit, loopStart: isLoopStart, connectedPorts, onAdd: handleAddPort, onEdit: handleEditNode },
      selected: isSelected,
    };
    flowNodeCache.set(n.id, { n, canEdit, loopStart: isLoopStart, connectedPorts, selected: isSelected, flow });
    return flow;
  }
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
    setNodeEditorOpen(false);
    setAddingStep(undefined);
    setFocusStep(undefined);
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
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Workflows</h1>
            <p className="text-sm text-muted-foreground">Automate model events with connected actions and conditions.</p>
          </div>
          {perms.edit && (
            <form
              className="flex items-center gap-2"
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
                className={`${control} w-48`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Workflow name"
                required
              />
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground hover:opacity-90 disabled:opacity-40"
              >
                <PlusIcon className="h-4 w-4" />
                New
              </button>
            </form>
          )}
        </div>

        {message && <p role="alert" className="mb-3 text-sm text-destructive">{message}</p>}

        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((x) => (
                <tr key={x.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link to={`/workflows/${x.id}`} className="font-medium text-foreground hover:underline">
                      {x.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {x.enabled ? 'Published · active' : 'Draft / paused'}
                  </td>
                </tr>
              ))}
              {!list.data.length && (
                <tr>
                  <td colSpan={2} className="px-3 py-6 text-center text-muted-foreground">
                    No records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  if (!w) return <div className="p-6">{detail.error?.message ?? 'Loading workflow…'}</div>;
  const g = w.draft;
  const node = g.nodes.find((n) => n.id === selected);
  const visibleNodes = g.nodes.filter((n) => n.parentId === scope);
  const loopStart: WorkflowNode | undefined = scope && !visibleNodes.length ? {
    id: `loop-start:${scope}`,
    kind: 'trigger',
    label: 'Loop start',
    position: { x: 60, y: 100 },
    inputs: {},
  } : undefined;
  const canvasNodes = loopStart ? [loopStart] : visibleNodes;
  const addStep = (kind: StepKind) => {
    if (!perms.edit || !addingStep || (scope && kind === 'foreach')) return;
    const source = canvasNodes.find((n) => n.id === addingStep.sourceId);
    if (!source || g.edges.some((e) => e.source === source.id && e.port === addingStep.port)) return;
    const firstInLoop = source.id === loopStart?.id;
    const position = {
      x: firstInLoop ? source.position.x : source.position.x + 300,
      y: source.position.y + (['false', 'partial'].includes(addingStep.port) ? 160 : 0),
    };
    while (visibleNodes.some((n) => Math.abs(n.position.x - position.x) < 240 && Math.abs(n.position.y - position.y) < 140))
      position.y += 160;
    const id = crypto.randomUUID();
    edit({
      ...g,
      nodes: [...g.nodes, {
        id,
        kind,
        label: stepTypes.find((step) => step.kind === kind)!.label,
        position,
        inputs: {},
        ...(scope ? { parentId: scope } : {}),
      }],
      edges: firstInLoop ? g.edges : [...g.edges, { source: source.id, target: id, port: addingStep.port }],
    });
    setAddingStep(undefined);
    setFocusStep(id);
    select(id);
    setNodeEditorOpen(true);
  };
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
    if (n.kind === 'model' && n.operation === 'query') {
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
  const modelOperation = node?.kind === 'model' ? node.operation : undefined;
  const isCustomOperation =
    !!modelOperation && !(BUILTIN_ACTIONS as readonly string[]).includes(modelOperation);
  const fields = isCustomOperation
    ? (model?.operations.find((o) => o.name === modelOperation)?.params ?? [])
    : (model?.fields.filter((f) => !f.sensitive) ?? []);
  const keys =
    node?.kind === 'condition'
      ? ['left', 'right']
      : node?.kind === 'foreach'
        ? ['items']
        : !modelOperation
          ? []
          : modelOperation === 'read' || modelOperation === 'remove'
            ? ['id']
            : modelOperation === 'update' || isCustomOperation
              ? ['id', ...fields.map((f) => f.key)]
              : fields.map((f) => f.key);
  return (
    <div className="flex h-[calc(100dvh-5rem)] flex-col">
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
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Workflow settings</Button>
          </DialogTrigger>
          <DialogContent className="top-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-y-1/2">
            <DialogTitle className="pr-8 text-lg font-semibold">Workflow settings</DialogTitle>
            <DialogDescription className="mb-4 text-sm text-muted-foreground">
              Choose the automation role and run this workflow manually.
            </DialogDescription>
            {message && <p role="alert" className="mb-4 text-sm">{message}</p>}
            <fieldset disabled={!perms.edit}>
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
            </fieldset>
            {perms.run && (
              <div className="mt-4 space-y-2 border-t pt-3">
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
                {dirty && <p className="text-xs text-muted-foreground">Save the draft before running.</p>}
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
          </DialogContent>
        </Dialog>
      </div>
      {scope && (
        <div className="flex items-center gap-3 border-b px-3 py-2">
          <Button variant="outline" onClick={() => {
            select(scope);
            setFocusStep(scope);
            setScope(undefined);
            setNodeEditorOpen(false);
            setAddingStep(undefined);
          }}>
            ← Main flow
          </Button>
          <span className="text-sm text-muted-foreground">{g.nodes.find((n) => n.id === scope)?.label} · Loop body</span>
        </div>
      )}
      {message && (
        <p role="alert" className="border-b px-4 py-2 text-sm">
          {message}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <main ref={canvasRef} tabIndex={-1} aria-label="Workflow canvas" className="min-w-0 flex-1">
          <ReactFlow
            nodes={canvasNodes.map((n) => buildFlowNode(n, n.id === loopStart?.id))}
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
            onNodeClick={(_, n) => {
              if (n.id === loopStart?.id) return;
              setAddingStep(undefined);
              select(n.id);
              setNodeEditorOpen(true);
            }}
            onNodesChange={(changes) => {
              // Recorded regardless of `perms.edit` (a viewer's nodes still get measured once on
              // mount) — see `measuredByNode`'s comment above.
              for (const c of changes) if (c.type === 'dimensions' && c.dimensions) measuredByNode.set(c.id, c.dimensions);
              if (!perms.edit) return;
              // Only rebuild the node(s) that actually moved — a drag fires this on every pointer
              // move, and `g.nodes.map((n) => ({ ...n, ... }))` over *every* node (as this used to
              // do, via `applyNodeChanges` over the whole list) would hand @xyflow/react a brand
              // new object for every node on every frame, defeating its per-node memoization and
              // forcing the whole canvas to re-render — the visible "blinking". Untouched nodes
              // must keep their existing object reference.
              const isMove = (c: (typeof changes)[number]): c is NodePositionChange =>
                c.type === 'position' && !!c.position;
              const moved = new Map(changes.filter(isMove).map((c) => [c.id, c.position]));
              if (moved.size === 0) return;
              edit({
                ...g,
                nodes: g.nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n)),
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
              if (perms.edit && c.source && c.target && c.source !== loopStart?.id &&
                  !g.edges.some((edge) => edge.source === c.source && edge.port === (c.sourceHandle ?? 'next')))
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
            fitViewOptions={{ padding: 0.25 }}
          >
            <Background />
            <Controls />
            <FocusNewStep nodeId={focusStep} onDone={() => setFocusStep(undefined)} />
            {addingStep && perms.edit && (
              <WorkflowNodePopover
                key={`add:${addingStep.sourceId}:${addingStep.port}`}
                nodeId={addingStep.sourceId}
                title={`Add step · ${addingStep.port}`}
                canvasRef={canvasRef}
                anchorSelector={`[data-add-port="${addingStep.port}"]`}
                closeLabel="Close step picker"
                onClose={() => setAddingStep(undefined)}
              >
                <div className="space-y-0.5">
                  {stepTypes.filter((step) => !scope || step.kind !== 'foreach').map((step) => (
                    <button
                      key={step.kind}
                      type="button"
                      className="block w-full rounded-md px-3 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => addStep(step.kind)}
                    >
                      <span className="block text-sm font-medium">{step.label}</span>
                      <span className="block text-xs text-muted-foreground">{step.description}</span>
                    </button>
                  ))}
                </div>
              </WorkflowNodePopover>
            )}
            {nodeEditorOpen && node && (
              <WorkflowNodePopover
                key={node.id}
                nodeId={node.id}
                title={node.kind === 'trigger' ? 'Edit trigger' : 'Edit step'}
                canvasRef={canvasRef}
                onClose={() => setNodeEditorOpen(false)}
              >
                <fieldset key={node?.id} disabled={!perms.edit} className="min-w-0 space-y-3">
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
                          {node.kind === 'model' && (
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
                          {node.kind === 'model' && node.model && (
                            <label className="block text-sm">
                              Operation
                              <select
                                aria-label="Operation"
                                className={control}
                                value={node.operation ?? ''}
                                onChange={(e) => patch({ operation: e.target.value, inputs: {} })}
                              >
                                <option value="">Choose operation</option>
                                <optgroup label="Built-in">
                                  {BUILTIN_OPERATIONS.map((o) => (
                                    <option key={o.name} value={o.name}>
                                      {o.label}
                                    </option>
                                  ))}
                                </optgroup>
                                {!!model?.operations.length && (
                                  <optgroup label="Custom">
                                    {model.operations.map((o) => (
                                      <option key={o.name} value={o.name}>
                                        {o.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                              </select>
                            </label>
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
                                  setFocusStep(g.nodes.find((step) => step.parentId === node.id)?.id ?? `loop-start:${node.id}`);
                                  select('');
                                  setNodeEditorOpen(false);
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
                              setNodeEditorOpen(false);
                            }}
                          >
                            Delete step
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </fieldset>
              </WorkflowNodePopover>
            )}
          </ReactFlow>
        </main>
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
