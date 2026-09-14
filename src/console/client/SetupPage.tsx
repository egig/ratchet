import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiRequestError } from './api.js';
import { useAuth } from './auth.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';

/** Shown instead of `/login` until `GET /api/auth/setup` reports a root admin already exists
 * (see `useAuth().setupRequired`). Creates the one `*:*` user via `POST /api/auth/setup` and
 * signs them in, same as a fresh login. Connecting a Model Provider for the built-in `Ratchet`
 * `Agent` is a separate step, done from the chat UI's empty-state once logged in — not part of
 * this form. Renders `NotFoundPage` instead of redirecting to `/login` once setup isn't
 * required, so a completed instance gives no more away than a production instance that disguises
 * `/setup` as missing entirely (see `src/auth/router.ts`). */
export function SetupPage() {
  const { loading, setupRequired, completeSetup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && !setupRequired) return <NotFoundPage />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completeSetup({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.code === 'SETUP_ALREADY_COMPLETE'
          ? 'A root admin was already created — sign in instead.'
          : 'Setup failed.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-foreground">Create the root admin</h1>
        <p className="mb-6 text-sm text-muted-foreground">This is a one-time setup step — this account gets full access.</p>

        <div className="mb-3 space-y-1.5">
          <Label htmlFor="setup-email">Email</Label>
          <Input
            id="setup-email"
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="mb-3 space-y-1.5">
          <Label htmlFor="setup-password">Password</Label>
          <Input
            id="setup-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className="mb-4 space-y-1.5">
          <Label htmlFor="setup-confirm-password">Confirm password</Label>
          <Input
            id="setup-confirm-password"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>

        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Creating…' : 'Create root admin'}
        </Button>
      </form>
    </div>
  );
}
