# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, ...) working in this project. Humans
are welcome too.

This is a [Ratchet](https://egig.github.io/ratchet/) app. You describe data as **models** in
`models/`. Ratchet generates the database tables, a REST API, an admin console, and login from
them. Custom behaviour goes in small functions chained with `pipe(...)`. The public website is
React Router pages in `routes/`.

## Commands

```sh
bun install          # once
bun run dev          # run the app; re-syncs the database and restarts on every save
bun run check        # validate models + type-check + tests. Run before saying you're done.
bun run seed         # load sample data from seed.ts (dev already does this)
```

- Site: http://localhost:3000. Admin console: http://localhost:3000/console.
- First console visit shows a one-time setup screen to create the admin account. Without a
  browser, run `bun run create-admin -- --email admin@example.com --password <password>`.
- Production only: `bun run generate` writes SQL migration files to `migrations/`, and
  `bun run migrate` applies them. Don't use these during normal development; `dev` handles it.

## Project layout

| Path | What | Edit? |
| --- | --- | --- |
| `models/**/*.model.ts` | one `defineModel(...)` per table | yes |
| `models/<folder>/` | the folder name is the console sidebar section (the "Domain") | yes |
| `models/<folder>/settings.domain.ts` | admin-editable settings for that section (`defineDomain`) | yes |
| `routes/**/*.tsx` | public website pages (React Router; file path = URL) | yes |
| `logic/` | plain TypeScript helpers shared by routes and models | yes |
| `seed.ts` | sample data, loaded by `dev` and `seed` | yes |
| `public/` | static files served as-is | yes |
| `ratchet.config.ts` | database, folders, console path, `auth` (better-auth options) | rarely |
| `.ratchet/` | **generated**, rewritten on every sync | **never** |
| `migrations/` | generated SQL for production | never by hand |
| `local.db` | the local SQLite database | delete it to start fresh |

## Rules

1. **Never edit `.ratchet/`.** Change the model instead. The next sync overwrites hand edits.
2. **One model per file.** Name files `<name>.model.ts` and export the result of
   `defineModel('<table_name>', { ... })`. The table name is plural snake_case (`'blog_posts'`)
   and must be unique.
3. **Refer to other models by table name.** Use `field.reference('categories')`, not the export
   name.
4. **Imports use `.js` extensions**, even for `.ts` files: `import { x } from '../logic/cart.js'`.
   The project uses NodeNext module resolution.
5. **Money is a string.** Use `field.decimal({ precision: 10, scale: 2 })`, with values like
   `"19.99"`. Never use a JS number for money.
6. **The API is locked by default.** Every `/api/<table>` route needs a logged-in user whose role
   has a permission for that model. That includes reads. Website pages in `routes/` don't go
   through the API: they query the database directly (see "Add a page"). Add
   `api: { public: true }` only when anonymous visitors really need the JSON API.
7. **Don't drop data casually.** `dev` applies schema changes to `local.db` without asking:
   - Removing or renaming a field deletes that column's data.
   - Adding a `required: true` field with no `default` to a table that already has rows **empties
     the whole table**. Give a new field on an existing model a `default`, or leave it optional.

   Tell the user before you make any of these changes to a model that holds real data.
8. **Finish with `bun run check`.** It must print `all checks passed.` If it fails, read the
   `error:` and `fix:` lines, fix the problem, and run it again.

## Recipes

### Add a model

```ts
// models/blog/post.model.ts  -> console section "blog", table "posts", API /api/posts
import { defineModel, field } from '@egig/ratchet/core';

export const Post = defineModel('posts', {
  fields: {
    title: field.string({ required: true, maxLength: 200 }),
    slug: field.string({ required: true, unique: true, indexed: true, maxLength: 200 }),
    body: field.text(),
    status: field.enum(['draft', 'published'] as const, { default: 'draft', indexed: true }),
    publishedAt: field.datetime(),
    authorId: field.reference('users'), // built-in users table
  },
  console: { label: 'Posts', displayField: 'title' },
});
```

Save the file and `dev` creates the table. Then add a guarded block to `seed.ts`, and run
`bun run check`.

Field types: `string`, `text`, `integer`, `decimal`, `boolean`, `datetime`, `enum`, `json`,
`reference` (many-to-one), `manyToMany`, `referenceToMany` (one-to-many), `tree` (parent/child,
one per model), and `file` (upload).

Common options: `required`, `default`, `unique`, `indexed`, `displayText` (label),
`description` (help text shown in the console), and `hideInTable`. You can't combine `required`
and `default` on one field.

Every table also gets `id`, `createdAt`, `updatedAt`, `deletedAt` (soft delete) and
`createdById` automatically. Don't declare these.

### Add custom logic to create/update

```ts
import { defineModel, field, pipe, validate, persist, PipelineError, type PipelineFn } from '@egig/ratchet/core';

const rejectPastDates: PipelineFn = (ctx) => {
  if (ctx.input.startsAt && new Date(String(ctx.input.startsAt)) < new Date()) {
    throw new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { startsAt: 'must be in the future' } });
  }
  return ctx;
};

export const Event = defineModel('events', {
  fields: { title: field.string({ required: true }), startsAt: field.datetime({ required: true }) },
  operations: {
    create: pipe(rejectPastDates, validate, persist),
    update: pipe(rejectPastDates, validate, persist),
  },
});
```

Steps before `persist` run in one database transaction, and a throw rolls the whole thing back.
Steps after `persist` run once the row is saved; use them for emails and other side effects.

- `ctx.input` is the incoming data.
- `ctx.doc` is the existing row (on update) or the saved row (after `persist`).
- `ctx.db` is the database.

Don't add `requireAuth` or `requirePermission` yourself; the API applies them.

### Add a button / action (custom operation)

```ts
import { presetFields } from '@egig/ratchet/auth';
// inside defineModel(...):
operations: {
  archive: {
    pipeline: presetFields({ status: 'archived' }),
    description: 'Archive this post.',
    console: { label: 'Archive', confirm: 'Archive this post?', visibleWhen: { field: 'status', equals: 'published' } },
  },
},
```

This adds `POST /api/posts/:id/archive`, a console button, and a `posts:archive` permission.
Reserved names: `create`, `update`, `remove`, `read`, `query`, `upload`.

### Add a page

`routes/blog/index.tsx` serves `/blog`. `routes/blog/$slug.tsx` serves `/blog/:slug`. `loader`
runs on the server only.

Don't also create `routes/blog.tsx`. A file next to a folder of the same name becomes a layout
for everything in that folder, and it must render `<Outlet />`.

```tsx
import { useLoaderData, type LoaderFunctionArgs } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';

export async function loader({ context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const posts = await db.execute(
    sql`select slug, title from posts where status = 'published' and deleted_at is null order by created_at desc`,
  );
  return { posts: posts as unknown as { slug: string; title: string }[] };
}

export const meta = () => [{ title: 'Blog' }];

export default function Blog() {
  const { posts } = useLoaderData<typeof loader>();
  return <ul>{posts.map((p) => <li key={p.slug}><a href={`/blog/${p.slug}`}>{p.title}</a></li>)}</ul>;
}
```

- In raw SQL, columns are snake_case (`created_at`, `category_id`). Always filter
  `deleted_at is null`.
- Write portable SQL that works on SQLite and Postgres. Don't use `now()`; pass
  `new Date().toISOString()` instead.
- Site settings: `getWebContext(context).settings.get('website')`.
- The page shell (header, nav, footer) is `routes/root.tsx`.

### Add sign-in with GitHub, Google, ...

Sign-in is [better-auth](https://www.better-auth.com), mounted at `/api/auth`. Add providers under
`auth` in `ratchet.config.ts`; the options are better-auth's own:

```ts
auth: {
  socialProviders: {
    github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
  },
},
```

Register `<origin>/api/auth/callback/github` with the provider. Production needs
`BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `BETTER_AUTH_URL` (the public origin) set.
Don't add a password column or a sessions table yourself: users, sessions, and sign-in accounts
are built in. A better-auth plugin that adds columns to `user`/`session` isn't supported yet.

### Add a feature plugin

Feature packages (for example `@egig/ratchet-automation`: AI agents, chat, workflows) are
installed with `bun add <package>` and listed in `ratchet.config.ts` under
`plugins: [automation()]`. Then run `ratchet generate` and review the migration it writes: a
plugin brings its own tables. Removing a plugin drops them on the next migration.

### Add admin-editable settings

Create `models/<folder>/settings.domain.ts` with `defineDomain('<folder>', { settings: { ... } })`.
The domain name must match the folder. For a full example, see
`models/website/settings.domain.ts`.

## When something breaks

- **`bun run dev` prints `error:` / `fix:`.** Do what the `fix:` line says and save. `dev`
  retries on its own and keeps the last good server running meanwhile.
- **"no such table" / "relation does not exist".** The database is behind your models. Save any
  model file to trigger a sync, or restart `bun run dev`.
- **The database is in a confusing state (local only).** Stop `dev`, delete `local.db`, and start
  `dev` again. The seed data comes back. Everything else in the database is lost, including the
  admin account, so ask the user first.

## Docs

https://egig.github.io/ratchet/docs. The most useful pages are Models, Pipelines, Custom
Operations, Web, and Auth.
