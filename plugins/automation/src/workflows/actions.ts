// Browser-safe (no framework imports) — the console's workflow editor imports this directly, so it
// must not drag `@egig/ratchet/core` (and its DB drivers) into the client bundle.

/** The five built-in record actions every model exposes for free in a workflow's Model Operation
 * step — anything else typed into `operation` is a custom operation name looked up on the model
 * (`ModelDefinition.operations`, core/model.ts). `'query'` is reserved off that map too
 * (`RESERVED_OPERATION_NAMES`) so a custom operation can never collide with it. */
export const BUILTIN_ACTIONS = ['query', 'read', 'create', 'update', 'remove'] as const;
export type BuiltinAction = (typeof BUILTIN_ACTIONS)[number];
