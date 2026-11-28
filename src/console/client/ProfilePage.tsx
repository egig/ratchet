import { useState, type FormEvent } from 'react';
import { useNavigate } from './router.js';
import { ApiRequestError, type ProfileInput } from './api.js';
import { useAuth } from './auth.js';
import { BrandMark } from './BrandMark.js';
import { CheckIcon, ChevronLeftIcon } from './icons.js';

/** Self-service profile edit — the one form a non-admin user can reach to change their own
 * email/password (better-auth's `/api/auth/change-email` and `/change-password`; the latter
 * requires the current password and signs out every other session). Deliberately standalone (its own
 * thin header, no `Layout` sidebar): it's linked from both the console sidebar's `AccountMenu`
 * and the workspace header's `UserMenu`, and a workspace user has no business landing in the
 * model sidebar just to change their password. */
export function ProfilePage() {
  const { user, updateProfile } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!user) return null;

  function clearStatus() {
    setSaved(false);
    setFormError(null);
    setFieldErrors({});
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      const input: ProfileInput = {};
      if (email !== user!.email) input.email = email;
      if (password) {
        input.newPassword = password;
        input.currentPassword = currentPassword;
      }
      if (!input.email && !input.newPassword) {
        setSaved(true);
        return;
      }
      await updateProfile(input);
      setPassword('');
      setCurrentPassword('');
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setFormError(err.fields ? null : err.message);
        setFieldErrors(err.fields ?? {});
      } else {
        setFormError(err instanceof Error ? err.message : 'Save failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-4">
        <BrandMark />
      </header>

      <div className="mx-auto max-w-lg px-4 py-8">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-4 flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ChevronLeftIcon className="h-4 w-4" />
          Back
        </button>

        <h1 className="mb-4 text-lg font-semibold text-gray-900">Edit profile</h1>

        {formError && <p className="mb-4 text-sm text-red-600">{formError}</p>}
        {saved && !formError && Object.keys(fieldErrors).length === 0 && (
          <p className="mb-4 text-sm text-green-600">Profile saved.</p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-gray-200 bg-white p-6">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearStatus();
              }}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
            {fieldErrors.email && <span className="mt-1 block text-xs text-red-600">{fieldErrors.email}</span>}
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Current password</span>
            <input
              type="password"
              value={currentPassword}
              required={password.length > 0}
              placeholder="Required to set a new password"
              autoComplete="current-password"
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                clearStatus();
              }}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">New password</span>
            <input
              type="password"
              value={password}
              placeholder="Leave blank to keep current"
              autoComplete="new-password"
              onChange={(e) => {
                setPassword(e.target.value);
                clearStatus();
              }}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
            {fieldErrors.password && <span className="mt-1 block text-xs text-red-600">{fieldErrors.password}</span>}
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-1.5 rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  );
}
