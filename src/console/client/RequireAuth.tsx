import { Navigate, Outlet } from './router.js';
import { useAuth } from './auth.js';
import { ModelsProvider } from './models.js';
import { DomainsProvider } from './domains.js';

export function RequireAuth() {
  const { user, loading, setupRequired } = useAuth();

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <ModelsProvider>
      <DomainsProvider>
        <Outlet />
      </DomainsProvider>
    </ModelsProvider>
  );
}
