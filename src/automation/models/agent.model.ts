import { defineModel, field } from '../../core/index.js';

/**
 * A reusable assistant config — system prompt + provider/model + tools — not a live
 * conversation. `Chat` rows reference an `Agent`; every turn in that chat is run by
 * `runAgentTurn` (src/automation/run-turn.ts) via LangChain's `createAgent`, with the chat model
 * built by `src/automation/model-factory.ts` from whichever `Provider` row `providerId` points at
 * (src/automation/models/provider.model.ts) rather than an agent typing a key directly. An
 * agent's tools aren't declared here at all — they're whatever grants sit in `roleId`'s `Role`'s
 * own `permissions` array (src/auth/models/role.model.ts), expanded into callable model-operation
 * tools by `src/automation/tool.ts`. An agent with no `roleId` is offered no tools.
 */
export const Agent = defineModel('agents', {
  fields: {
    name: field.string({ required: true, unique: true, indexed: true, maxLength: 255 }),
    description: field.text({ required: false }),
    systemPrompt: field.text({ required: true }),
    providerId: field.reference('providers', { required: false, indexed: true, displayText: 'Provider' }),
    roleId: field.reference('roles', { required: false, indexed: true, displayText: 'Role' }),
    model: field.string({ default: 'openrouter/auto', maxLength: 255 }),
    // provider-specific passthrough (e.g. { effort: 'high' }) — ignored by adapters that don't
    // support a given key.
    config: field.json({ required: false }),
    active: field.boolean({ default: true }),
  },
  console: { label: 'Agents', displayField: 'name' },
});
