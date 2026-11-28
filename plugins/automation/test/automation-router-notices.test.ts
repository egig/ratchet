import { describe, expect, it } from 'bun:test';
import { emptyTurnNotice, summarizeTurnError, turnFailureNotice } from '../src/agents/router.js';

// `POST /api/automation/chat` (router.ts) used to persist an assistant `Message` row only when
// `AssistantPartsBuilder` had something in it — so a turn that threw before any token streamed,
// or one that legitimately ended empty (aborted/refused/timed out before producing content), left
// no row at all: the failure vanished on the next history reload as if the turn never happened.
// The fix always persists a row and fills it with one of these notices when `parts` would
// otherwise be empty. These are pure functions extracted so that fix is covered without spinning
// up the full router + Postgres stack the route itself needs.
describe('emptyTurnNotice', () => {
  it('has a specific notice for every non-normal stopReason the loop can end on', () => {
    expect(emptyTurnNotice('aborted')).toBe('_Stopped._');
    expect(emptyTurnNotice('refusal')).toBe('_The model declined to answer._');
    expect(emptyTurnNotice('max_tokens')).toBe('_Response was cut off (length limit) before producing any content._');
    expect(emptyTurnNotice('max_iterations')).toBe('_Stopped after too many tool-call rounds without a final answer._');
    expect(emptyTurnNotice('timeout')).toBe('_The agent turn timed out._');
  });

  it('falls back to a generic notice for an unrecognized or "end_turn" stopReason', () => {
    expect(emptyTurnNotice('end_turn')).toBe('_The agent returned an empty response._');
    expect(emptyTurnNotice('something-new')).toBe('_The agent returned an empty response._');
  });
});

describe('turnFailureNotice', () => {
  it('has no leading blank line when nothing had streamed yet', () => {
    expect(turnFailureNotice('network error', false)).toBe('_Agent turn failed: network error_');
  });

  it('leads with a blank line when some content already streamed, so it reads as a continuation', () => {
    expect(turnFailureNotice('network error', true)).toBe('\n\n_Agent turn failed: network error_');
  });
});

// `POST /api/automation/chat` logs the full thrown error server-side but must never render a raw
// provider error (often a whole HTTP/JSON body) into the chat bubble — `summarizeTurnError`
// collapses it to one clean line.
describe('summarizeTurnError', () => {
  it('recognises credential failures', () => {
    expect(summarizeTurnError(new Error('401 {"error":{"message":"Invalid API key provided"}}'))).toContain('API key');
  });

  it('recognises rate limiting', () => {
    expect(summarizeTurnError(new Error('Error 429: rate limit exceeded'))).toContain('rate-limiting');
  });

  it('recognises provider outages', () => {
    expect(summarizeTurnError(new Error('503 Service Unavailable — overloaded_error'))).toContain('temporarily unavailable');
  });

  it('recognises network failures', () => {
    expect(summarizeTurnError(new Error('fetch failed: ECONNREFUSED'))).toContain('reach the model provider');
  });

  it('recognises an oversized conversation', () => {
    expect(summarizeTurnError(new Error('This model\'s maximum context length is 8192 tokens'))).toContain('too long');
  });

  it('falls back to a generic line that points at the logs for anything unrecognised', () => {
    const huge = new Error('x'.repeat(5000));
    expect(summarizeTurnError(huge)).toBe('unexpected error — see the server logs for details');
  });

  it('handles a non-Error throw', () => {
    expect(summarizeTurnError('boom')).toBe('unexpected error — see the server logs for details');
    expect(summarizeTurnError(undefined)).toBe('unexpected error — see the server logs for details');
  });
});
