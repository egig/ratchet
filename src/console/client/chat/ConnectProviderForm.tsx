import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, createRow, updateRow } from '../api.js';
import { queryKeys } from '../query-keys.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/** Shown in place of the thread when the active agent has no `providerId` — connecting a Model
 * Provider used to be forced on the setup wizard; it now happens here instead, at the point the
 * operator actually needs it. Creates a `Provider` row and points the agent at it through the
 * same generic `/api/providers` + `/api/agents/:id` endpoints the Providers admin screen uses, so
 * it's gated by the same `providers:create`/`agents:update` permission (satisfied automatically
 * by the Root role's `*:*`) — no bypass endpoint. */
export function ConnectProviderForm({ agentId, agentName }: { agentId: string; agentName: string }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const provider = await createRow('providers', {
        name: `${agentName} Provider`,
        kind,
        apiKey,
        url: url.length > 0 ? url : undefined,
      });
      await updateRow('agents', agentId, { providerId: provider.id as string });
      await queryClient.invalidateQueries({ queryKey: queryKeys.rows('agents') });
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 403
          ? "You don't have permission to configure a provider — ask an admin."
          : 'Could not connect the provider.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
      <form onSubmit={handleSubmit} className="w-full max-w-xs">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Connect a model provider</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{agentName}</span> needs a provider before it can talk.
        </p>

        <div className="mb-3 space-y-1.5">
          <Label htmlFor="provider-kind">Provider</Label>
          <select
            id="provider-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'anthropic' | 'openai')}
            className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </div>

        <div className="mb-3 space-y-1.5">
          <Label htmlFor="provider-key">API key</Label>
          <Input id="provider-key" type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>

        <div className="mb-4 space-y-1.5">
          <Label htmlFor="provider-url">Base URL (optional)</Label>
          <Input id="provider-url" type="url" placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>

        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Connecting…' : 'Connect provider'}
        </Button>
      </form>
    </div>
  );
}
