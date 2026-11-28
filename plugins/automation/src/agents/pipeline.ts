import { PipelineError } from '@egig/ratchet/core';
import type { UserRow } from '@egig/ratchet/auth';

/** The generic `/api/:model` router only has `requirePermission` (role/global) — no row-level
 * ownership check. `Chat`/`Message` reads and writes go through the dedicated routes in
 * src/automation/router.ts instead, which call this after loading the row. */
export function assertOwnsChat(chat: Record<string, unknown> | null, user: UserRow): asserts chat is Record<string, unknown> {
  if (!chat || chat.userId !== user.id) {
    throw new PipelineError({ code: 'NOT_FOUND', status: 404 });
  }
}
