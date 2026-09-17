import { z } from 'zod';
import { buildParamsSchema } from '../core/validation.js';
import type { FieldDefinition } from '../core/field.js';
import type { ModelDefinition } from '../core/model.js';

const binding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.json() }),
  z.object({ kind: z.literal('ref'), source: z.string(), path: z.array(z.string()) }),
]);
export type Binding = z.infer<typeof binding>;
const node = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  kind: z.enum([
    'trigger',
    'query',
    'read',
    'create',
    'update',
    'remove',
    'operation',
    'condition',
    'foreach',
  ]),
  label: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  parentId: z.string().optional(),
  model: z.string().optional(),
  operation: z.string().optional(),
  inputs: z.record(z.string(), binding).default({}),
  operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'exists']).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
});
export const graphSchema = z.object({
  nodes: z.array(node).min(1).max(100),
  edges: z
    .array(
      z.object({
        source: z.string(),
        target: z.string(),
        port: z.enum(['next', 'true', 'false', 'success', 'partial']).default('next'),
      }),
    )
    .max(200),
  trigger: z.object({ model: z.string(), event: z.enum(['create', 'update', 'remove', 'manual']) }),
});
export type Graph = z.infer<typeof graphSchema>;
export type WorkflowNode = Graph['nodes'][number];
export const defaultGraph = (): Graph => ({
  trigger: { model: '', event: 'manual' },
  nodes: [{ id: 'trigger', kind: 'trigger', label: 'Trigger', position: { x: 60, y: 100 }, inputs: {} }],
  edges: [],
});

/** Restrict v1 to structured branches: each output has one successor, and joins are rejected.
 * This makes reference availability and recovery deterministic without an implicit join policy. */
export function validateGraph(value: unknown, registry: Record<string, ModelDefinition>): Graph {
  const g = graphSchema.parse(value);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const fail = (message: string): never => {
    throw new Error(message);
  };
  if (g.nodes.some((n) => ['__proto__', 'prototype', 'constructor', 'item'].includes(n.id)))
    fail('Reserved node ID');
  if (byId.size !== g.nodes.length) fail('Node IDs must be unique');
  const triggers = g.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length !== 1 || triggers[0]!.parentId) fail('Exactly one top-level trigger is required');
  if (g.trigger.event !== 'manual' && !registry[g.trigger.model]) fail('Choose a valid trigger model');
  const parents = new Map<string, string>();
  const ports = new Set<string>();
  for (const e of g.edges) {
    const from = byId.get(e.source),
      to = byId.get(e.target);
    if (!from || !to) fail('An edge references a missing node');
    if (from!.parentId !== to!.parentId) fail('Connections must stay inside their loop or top-level graph');
    if (to!.kind === 'trigger' || parents.has(e.target))
      fail('Branch joins and incoming trigger edges are not supported');
    parents.set(e.target, e.source);
    const allowed =
      from!.kind === 'condition'
        ? ['true', 'false']
        : from!.kind === 'foreach'
          ? ['success', 'partial']
          : ['next'];
    if (!allowed.includes(e.port)) fail(`Invalid output on ${e.source}`);
    const key = `${e.source}:${e.port}`;
    if (ports.has(key)) fail('Each output can connect to only one next node');
    ports.add(key);
  }
  for (const n of g.nodes) {
    if (n.parentId && (byId.get(n.parentId)?.kind !== 'foreach' || byId.get(n.parentId)?.parentId))
      fail('Only one level of For each is supported');
    if (n.kind === 'foreach' && n.parentId) fail('Nested loops are not supported');
    if (['query', 'read', 'create', 'update', 'remove', 'operation'].includes(n.kind)) {
      const m = registry[n.model ?? ''];
      if (!m || m.api?.hidden) fail(`Unknown or private model on ${n.label}`);
      if (n.kind === 'operation' && !m!.operations[n.operation ?? ''])
        fail(`Unknown operation on ${n.label}`);
      for (const key of Object.keys(n.inputs)) {
        if (['id', 'items', 'left', 'right'].includes(key)) continue;
        const fields =
          n.kind === 'operation'
            ? typeof m!.operations[n.operation!] === 'function'
              ? {}
              : ((m!.operations[n.operation!] as { params?: Record<string, unknown> }).params ?? {})
            : m!.fields;
        if (!(key in fields)) fail(`Unknown input ${key} on ${n.label}`);
        if (m!.fields[key]?.sensitive) fail('Sensitive fields are not available in workflows');
      }
    }
    const ancestors = new Set<string>();
    let current: string | undefined = n.id;
    while ((current = parents.get(current))) {
      if (ancestors.has(current) || current === n.id) fail('Backward connections are not supported');
      ancestors.add(current);
    }
    if (n.parentId) {
      ancestors.add(n.parentId);
      let p: string | undefined = n.parentId;
      while ((p = parents.get(p))) ancestors.add(p);
    }
    const targetModel = registry[n.model ?? ''];
    const operation = targetModel?.operations[n.operation ?? ''];
    const targetFields =
      n.kind === 'operation'
        ? typeof operation === 'object'
          ? (operation.params ?? {})
          : {}
        : (targetModel?.fields ?? {});
    const required =
      n.kind === 'read' || n.kind === 'update' || n.kind === 'remove' || n.kind === 'operation'
        ? ['id']
        : n.kind === 'foreach'
          ? ['items']
          : n.kind === 'condition'
            ? n.operator === 'exists'
              ? ['left']
              : ['left', 'right']
            : [];
    if (n.kind === 'condition' && !n.operator) fail('Choose a condition operator');
    if (n.kind === 'create' || n.kind === 'operation')
      for (const [key, f] of Object.entries(targetFields))
        if (f.required && f.default === undefined && key !== targetModel?.api?.ownerField) required.push(key);
    for (const key of required) if (!n.inputs[key]) fail(`Missing ${key} on ${n.label}`);
    for (const [key, b] of Object.entries(n.inputs)) {
      const target = targetFields[key];
      if (b.kind === 'literal' && target && ['create', 'update', 'operation'].includes(n.kind)) {
        if (!buildParamsSchema({ [key]: target }).safeParse({ [key]: b.value }).success)
          fail(`Invalid value for ${key} on ${n.label}`);
      }
      if (b.kind === 'literal' && key === 'items' && !Array.isArray(b.value)) fail('For each needs an array');
      if (b.kind === 'literal' && key === 'id' && typeof b.value !== 'string') fail('Record ID must be text');
      if (b.kind === 'ref') {
        const source = referenceModel(g, n, b, registry);
        if (source) {
          const field = source.model.fields[source.field];
          if (!field && !['id', 'createdAt', 'updatedAt', 'createdById'].includes(source.field))
            fail(`Unknown source field ${source.field}`);
          if (field?.sensitive) fail('Sensitive fields are not available in workflows');
          if (
            field &&
            target &&
            field.kind !== target.kind &&
            !(
              ['string', 'text', 'reference', 'tree', 'enum'].includes(field.kind) &&
              ['string', 'text', 'reference', 'tree', 'enum'].includes(target.kind)
            )
          )
            fail(`Incompatible field types for ${key} on ${n.label}`);
        }
      }
      if (b.kind !== 'ref') continue;
      if (!b.path.length) fail('Choose a specific source field');
      if (b.path.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p)))
        fail('Invalid field path');
      if (b.source === 'item' ? !n.parentId : b.source !== 'trigger' && !ancestors.has(b.source))
        fail(`Input on ${n.label} must reference an earlier node`);
    }
    if (n.kind !== 'trigger' && !n.parentId && !ancestors.has(triggers[0]!.id))
      fail(`Connect ${n.label} to the trigger`);
    if (n.kind === 'foreach') {
      const body = g.nodes.filter((x) => x.parentId === n.id);
      if (!body.length || body.filter((x) => !parents.has(x.id)).length !== 1)
        fail('Each loop needs one connected body');
    }
  }
  return g;
}
export function resolveBinding(b: Binding, values: Record<string, unknown>): unknown {
  if (b.kind === 'literal') return b.value;
  let value = values[b.source];
  for (const part of b.path) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error('Invalid field path');
    value =
      value != null && typeof value === 'object' && Object.hasOwn(value, part)
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }
  if (value === undefined) throw new Error(`Missing value: ${b.source}.${b.path.join('.')}`);
  return value;
}
export function evaluateCondition(op: WorkflowNode['operator'], left: unknown, right: unknown): boolean {
  switch (op) {
    case 'equals':
      return JSON.stringify(left) === JSON.stringify(right);
    case 'notEquals':
      return JSON.stringify(left) !== JSON.stringify(right);
    case 'greaterThan':
      return compareNumbers(left, right) > 0;
    case 'lessThan':
      return compareNumbers(left, right) < 0;
    case 'contains':
      return typeof left === 'string' && typeof right === 'string'
        ? left.includes(right)
        : Array.isArray(left) && left.includes(right);
    case 'exists':
      return left !== null && left !== undefined && (!Array.isArray(left) || left.length > 0);
    default:
      throw new Error('Choose a condition operator');
  }
}

/** Resolve record-field references for validation and fresh read authorization on resumed runs. */
export function referenceModel(
  g: Graph,
  n: WorkflowNode,
  b: Binding,
  registry: Record<string, ModelDefinition>,
): { model: ModelDefinition; field: string } | undefined {
  if (b.kind !== 'ref') return;
  if (b.source === 'trigger') {
    const model = registry[g.trigger.model];
    return model && ['before', 'after'].includes(b.path[0] ?? '') && b.path[1]
      ? { model, field: b.path[1] }
      : undefined;
  }
  let source = g.nodes.find((x) => x.id === b.source);
  if (b.source === 'item') {
    const loop = g.nodes.find((x) => x.id === n.parentId);
    const binding = loop?.inputs.items;
    source = binding?.kind === 'ref' ? g.nodes.find((x) => x.id === binding.source) : undefined;
  }
  const model = registry[source?.model ?? ''];
  return model &&
    b.path[0] &&
    source?.kind !== 'condition' &&
    source?.kind !== 'foreach' &&
    !(source?.kind === 'query' && b.source !== 'item')
    ? { model, field: b.path[0] }
    : undefined;
}

function compareNumbers(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number')
    return left === right ? 0 : left > right ? 1 : -1;
  const a = String(left),
    b = String(right);
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b))
    throw new Error('Numeric conditions require numbers or decimal values');
  const scale = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0);
  const integer = (v: string) => {
    const [whole, fraction = ''] = v.split('.');
    return BigInt(whole! + fraction.padEnd(scale, '0'));
  };
  const x = integer(a),
    y = integer(b);
  return x === y ? 0 : x > y ? 1 : -1;
}
