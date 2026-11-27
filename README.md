<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.png">
    <img src="docs/public/logo.png" alt="Ratchet" width="120">
  </picture>
</p>

<h1 align="center">Ratchet</h1>

<p align="center">The backend starter kit your coding agent already understands.</p>

Start a full app (database, REST API, admin console, login, and a sample storefront) in one command. Then build it by describing what you want to a coding agent like Claude Code, Cursor, or Codex, or by writing a few lines of TypeScript yourself.

## Quick start

You need [Bun](https://bun.sh) 1.3+. Nothing else: the database is a local SQLite file, created automatically.

```sh
mkdir my-app && cd my-app
bunx @egig/ratchet init
bun install
bun run dev
```

Open http://localhost:3000 for the site and http://localhost:3000/console for the admin. Your first console visit creates your login. Sample products and pages are already loaded.

## Build it with your agent

Open the folder in your coding agent and ask for what you want: "add a blog with posts and tags", "customers should have a loyalty tier", "add a page that lists upcoming events". Every project comes ready for that:

- **`AGENTS.md`** (plus a `CLAUDE.md` that imports it) explains how the project works: where models, pages, and logic go, what never to edit, and what can lose data.
- **Agent skills** in `.claude/skills/` (`add-model`, `add-page`, `add-logic`) walk the agent through the common changes.
- **`bun run dev`** picks up every save: it updates the database, reloads sample data from `seed.ts`, and restarts.
- **`bun run check`** validates models, type-checks, and runs tests, then prints one PASS/FAIL report. Errors name the file and add a `fix:` line, so the agent can correct itself.

## What a model looks like

One file per table. Ratchet generates the database table, a validated REST API, and admin screens from it:

```ts
// models/blog/post.model.ts
import { defineModel, field } from '@egig/ratchet/core';

export const Post = defineModel('posts', {
  fields: {
    title: field.string({ required: true, maxLength: 200 }),
    body: field.text(),
    status: field.enum(['draft', 'published'] as const, { default: 'draft' }),
  },
});
```

Custom logic goes in small functions chained with `pipe(...)`, and the public site is React Router pages in `routes/`. Auth, roles, and field-level permissions apply to every API route by default.

## Going to production

Switch to Postgres or Turso with `DATABASE_URL` (see `docs/content/docs/database.mdx`). Use reviewable migrations: `bun run generate` writes the SQL and `bun run migrate` applies it. `ratchet build` produces a plain-Node server for any host.

## Documentation

Full guides (models & fields, pipelines, the REST API, CLI reference) are in [`docs/`](./docs).

## License

MIT
