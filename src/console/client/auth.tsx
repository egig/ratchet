import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  setup as apiSetup,
  setupStatus as apiSetupStatus,
  updateProfile as apiUpdateProfile,
  type AuthUser,
  type ProfileInput,
  type SetupInput,
} from './api.js';
import { queryKeys } from './query-keys.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** true until any user holds a `*:*` permission — see `hasRootAdmin` (src/auth/lookup.ts). */
  setupRequired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: (input: SetupInput) => Promise<void>;
  updateProfile: (input: ProfileInput) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Hydrates from better-auth's `ratchet.session_token` cookie (set by `/api/auth/sign-in/email`) via `GET /api/auth/me`
 * on mount, so a page reload stays logged in without any client-side token storage. Also checks
 * `GET /api/auth/setup` alongside it, so the app knows on first paint whether to route to the
 * root-admin onboarding screen instead of the normal login page. Both run as React Query queries
 * (in parallel, same as the old `Promise.all`) so a successful login/setup can seed `me`'s cache
 * directly instead of re-triggering a fetch. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiMe().catch(() => null),
  });
  const setupStatusQuery = useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: () => apiSetupStatus().catch(() => ({ required: false })),
  });

  const loginMutation = useMutation({
    // better-auth's sign-in response doesn't include resolved `permissions` (only `/me` does) —
    // re-hydrate through the same path the initial page-load query uses, so a fresh login and a
    // reload always agree on what the user can see.
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      await apiLogin(email, password);
      return apiMe();
    },
    onSuccess: (user) => queryClient.setQueryData(queryKeys.me, user),
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      try {
        await apiLogout();
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 401) throw err;
      }
    },
    onSuccess: () => queryClient.setQueryData(queryKeys.me, null),
  });

  const setupMutation = useMutation({
    mutationFn: async (input: SetupInput) => {
      await apiSetup(input);
      return apiMe();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.setupStatus, { required: false });
      queryClient.setQueryData(queryKeys.me, user);
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: (input: ProfileInput) => apiUpdateProfile(input),
    onSuccess: (user) => queryClient.setQueryData(queryKeys.me, user),
  });

  const login = useCallback(
    async (email: string, password: string) => {
      await loginMutation.mutateAsync({ email, password });
    },
    [loginMutation],
  );

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync();
  }, [logoutMutation]);

  const completeSetup = useCallback(
    async (input: SetupInput) => {
      await setupMutation.mutateAsync(input);
    },
    [setupMutation],
  );

  const updateProfile = useCallback(
    async (input: ProfileInput) => {
      await updateProfileMutation.mutateAsync(input);
    },
    [updateProfileMutation],
  );

  return (
    <AuthContext.Provider
      value={{
        user: meQuery.data ?? null,
        loading: meQuery.isLoading || setupStatusQuery.isLoading,
        setupRequired: setupStatusQuery.data?.required ?? false,
        login,
        logout,
        completeSetup,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
