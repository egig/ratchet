import { defineModel, field, pipe, validate, persist } from '@egig/ratchet/core';
import { requireAuth, requirePermission } from '@egig/ratchet/auth';

/**
 * One turn in a `Chat` — written only by `/api/automation/chats/*` routes
 * (src/automation/router.ts), never through generic REST (see `Chat`'s comment for why
 * `api: { hidden: true }` is what actually enforces that, not just `operations`/permissions).
 *
 * `content` is a parts array in assistant-ui's `ThreadMessage` shape — `[{ type: 'text', text }]`,
 * `[{ type: 'reasoning', text }]`, `[{ type: 'tool-call', toolCallId, toolName, args, result }]`,
 * or a mix — stored as a JSON blob and round-tripped by the console's `ThreadHistoryAdapter`
 * (`src/console/client/chat/history.ts`). The server (`src/automation/router.ts`) is the only
 * writer: it persists the user turn and, at stream end, the assistant turn assembled from
 * `runAgentTurn`'s events.
 */
export const Message = defineModel('messages', {
  fields: {
    chatId: field.reference('chats', { required: true, indexed: true, displayText: 'Chat' }),
    role: field.enum(['user', 'assistant', 'tool'], { required: true, indexed: true }),
    // assistant-ui message parts (see model comment above) — never plain text.
    content: field.json({ required: true }),
    // { usage, stopReason, model } — provider response metadata; surfaced only as a muted footer
    // on assistant messages (console `MessageMetadataFooter`), never as body text.
    metadata: field.json({ required: false }),
  },
  operations: {
    create: pipe(requireAuth, requirePermission('messages', 'create'), validate, persist),
    update: pipe(requireAuth, requirePermission('messages', 'update'), validate, persist),
    remove: pipe(requireAuth, requirePermission('messages', 'remove'), persist.remove),
  },
  console: { hidden: true },
  api: { hidden: true },
});
