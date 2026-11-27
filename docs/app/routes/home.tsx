import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Link } from 'react-router';
import { baseOptions } from '@/lib/layout.shared';

const features = [
  {
    title: 'Running in one command',
    details:
      'Database, API, admin console, login, and a sample storefront with seed data. No database to install, nothing to configure.',
  },
  {
    title: 'Your agent already knows the rules',
    details:
      'Every project ships an AGENTS.md and agent skills that tell Claude Code, Cursor, or Codex how to add models, pages, and logic correctly.',
  },
  {
    title: 'One command says "done"',
    details:
      '`bun run check` validates models, type-checks, and runs tests, with errors that name the file and say how to fix it.',
  },
  {
    title: 'Describe it, and it gets built',
    details: 'One model file becomes a table, a validated REST API, and admin screens. Save it and the running app updates.',
  },
  {
    title: 'Secure by default',
    details: 'Auth, roles, and permissions apply to every route automatically, down to individual fields.',
  },
  {
    title: 'Grows with you',
    details: 'SQLite on day one, Postgres when you need it. Deploy to any Node host or container. No lock-in.',
  },
];

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Ratchet' },
    {
      name: 'description',
      content:
        'The backend starter kit your coding agent already understands. Start a full app in one command, then build it by describing what you want.',
    },
  ];
}

export default function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-col items-center text-center gap-6 px-4 py-24">
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt="Ratchet"
          width={96}
          height={96}
          className="block dark:hidden"
        />
        <img
          src={`${import.meta.env.BASE_URL}logo-dark.png`}
          alt="Ratchet"
          width={96}
          height={96}
          className="hidden dark:block"
        />
        <h1 className="text-4xl font-bold">Ratchet</h1>
        <p className="text-xl text-fd-muted-foreground">The backend starter kit your coding agent already understands.</p>
        <p className="max-w-xl text-fd-muted-foreground">
          Start a full app (database, API, admin, login) in one command. Then build it by describing what you want.
        </p>
        <div className="flex gap-4">
          <Link
            to="/docs/getting-started"
            className="rounded-md bg-fd-primary px-4 py-2 font-medium text-fd-primary-foreground"
          >
            Get Started
          </Link>
          <Link to="https://github.com/egig/ratchet" className="rounded-md border px-4 py-2 font-medium">
            View on GitHub
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-px bg-fd-border sm:grid-cols-2 lg:grid-cols-3 mx-auto max-w-4xl">
        {features.map((feature) => (
          <div key={feature.title} className="flex flex-col gap-2 bg-fd-background p-8">
            <h2 className="font-semibold">{feature.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{feature.details}</p>
          </div>
        ))}
      </div>
    </HomeLayout>
  );
}
