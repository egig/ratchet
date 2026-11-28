import { Navigate, NavLink, useParams } from './router.js';
import { useDomains } from './domains.js';
import { DomainSettingsForm } from './DomainSettingsForm.js';

const tabClassName = ({ isActive }: { isActive: boolean }) =>
  `border-b-2 px-3 py-2 text-sm font-medium ${
    isActive ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'
  }`;

/** One page for every Domain that has settings, tabbed by Domain — the single "Settings" sidebar
 * link (`Layout.tsx`) opens this instead of each Domain needing its own sidebar entry. `:domain`
 * (optional) picks the active tab and is deep-linkable; omitted, it redirects to the first Domain. */
export function SettingsPage() {
  const { domain: domainName } = useParams<{ domain: string }>();
  const { domains: allDomains, loading, getDomain } = useDomains();
  const domains = allDomains.filter((d) => d.fields.length > 0);

  if (loading) return <p className="text-sm text-gray-500">Loading…</p>;
  if (domains.length === 0) return <p className="text-sm text-gray-500">No Domain settings registered.</p>;

  if (!domainName) return <Navigate to={`/settings/${domains[0]!.name}`} replace />;

  const active = getDomain(domainName);
  if (!active || active.fields.length === 0) return <p className="text-sm text-red-600">Unknown domain.</p>;

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold text-gray-900">Settings</h1>

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {domains.map((d) => (
          <NavLink key={d.name} to={`/settings/${d.name}`} className={tabClassName}>
            {d.label}
          </NavLink>
        ))}
      </div>

      <DomainSettingsForm key={active.name} domain={active} />
    </div>
  );
}
