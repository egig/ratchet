# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ratchet (`@egig/ratchet`) is a model-driven backend framework. A directory of `*.model.ts` files is
scanned at codegen time and drives, from one declaration per table: the Drizzle schema (SQLite via
libsql by default, Postgres also supported — see [ADR 0004](docs/adr/0004-sqlite-libsql-second-db-driver.md)),
Zod validators, a generic REST API, a React admin console SPA, and better-auth sign-in
([ADR 0005](docs/adr/0005-better-auth.md)). Custom logic hooks
in as composable `pipe(...)` chains around `validate`/`persist`.

The repo ships the framework (`src/`), its docs site (`docs/`), and a working consumer app used for
manual testing (`example/`).

## Commands

Toolchain is **Bun** (package manager, bundler, test runner, runtime). Node is not needed to develop
the framework — it only matters because `ratchet build` emits a plain-Node server artifact.

```sh
bun install
bun run build          # scripts/build.ts: Bun.build (unbundled) src/ -> dist/, then tsc .d.ts, then copy console styles.css
bun run typecheck      # tsc -p tsconfig.json --noEmit  — tsc owns type-checking, the bundler does not
bun test               # bun:test (NOT vitest); test/*.test.ts
bun test test/tree.test.ts                 # single file
bun test test/router.test.ts -t "cursor"   # single test by name
```

Trying changes against `example/` (runs `src/cli/bin.ts` with cwd = `example/`):

```sh
bun run cli -- <command>   # e.g. bun run cli -- generate
bun run serve              # ratchet serve inside example/
```

Docs (Fumadocs on React Router, a Bun workspace member under `docs/`):

```sh
bun run docs:dev
bun run docs:build
```

### DB-backed tests silently skip

Several suites (`router`, `auth`, `workspace`, `site-assets`, ...) read
`process.env.DATABASE_URL` and `describe.skip` when it's unset — a bare `bun test` passes without
exercising them. To run the full suite, point `DATABASE_URL` at a **throwaway** database (each suite
creates and drops its own tables):

```sh
docker compose -f example/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ratchet_example
bun test
```

These suites test against Postgres specifically (their fixture tables are hand-written Postgres
DDL) — they're a fixed-dialect regression suite, not a stand-in for testing the SQLite path.
`test/helpers/db.ts`'s `connectTestDb()` centralizes the postgres-js client construction each of
them needs; the DDL itself stays per-suite.

## The consumer workflow (also how `example/` works)

1. `ratchet init` — scaffold `package.json`, `ratchet.config.ts`, `models/`, `migrations/`. The
   scaffold is a real project tree in [src/cli/stubs/](src/cli/stubs/), copied verbatim by
   [src/cli/commands/init.ts](src/cli/commands/init.ts) (only `package.json`'s `name` is templated;
   `stubs/gitignore` is written as `.gitignore`). `scripts/build.ts` copies the tree to
   `dist/cli/stubs/`. Edit the stub files, not string constants.
2. Write `models/**/*.model.ts` with `defineModel` / `field.*`.
3. `ratchet generate` — regenerate `.ratchet/*` (schema, validators, registry, domains, console
   forms/field-inputs), **then run `drizzle-kit generate`** to emit reviewable SQL migration files.
4. `ratchet migrate` — `drizzle-kit migrate` only; applies pending SQL. It no longer regenerates or
   diffs.
5. `ratchet serve` — boot the server (see below). `ratchet dev` watches models/routes/`seed.ts`
   and, per change, spawns the hidden `ratchet dev-sync` child (generate + `drizzle-kit push` +
   `seed.ts`) then restarts. The child process is load-bearing: Bun caches ES modules by URL, so an
   in-process re-`import()` of an edited model returns the stale one.
   `ratchet check` = models + `tsc` + tests, one PASS/FAIL report; `ratchet seed` runs `seed.ts`.

The product is positioned as an agent-ready starter kit: the scaffold's `AGENTS.md`, `CLAUDE.md`,
and `.claude/skills/` (in `src/cli/stubs/`) are user-facing docs for the consumer's coding agent.
Keep them accurate when the field DSL, CLI, or conventions change. On SQLite, enum `CHECK`
constraints are deliberately not emitted (drizzle-kit push bug; see `schema-gen.ts`).
6. `ratchet build` — hashed console client bundle + a bundled plain-Node `dist/server.js`.

`.ratchet/` (the `generatedDir`) is generated output — regenerate it, don't hand-edit.

## Architecture

### Codegen is the center of gravity

[src/codegen/generate.ts](src/codegen/generate.ts) scans `modelsDir` and writes `.ratchet/`:
`schema.ts`, `validators.ts`, `registry.ts`, `domains.ts`, `console-forms.ts`,
`console-field-inputs.ts`, `console-plugins.ts`, `app.ts`. `BUILTIN_MODELS` / `BUILTIN_FORMS`
([src/codegen/builtins.ts](src/codegen/builtins.ts)) inject the framework's own models (auth,
workspace) into the same scan — those live in `src/*/models/` and aren't reachable by the
consumer-dir walk, so their domain and import path are assigned explicitly. Plugin models join the
same way (`pluginScanEntries`, imported from the plugin's `module`). `.ratchet/app.ts` imports
`ratchet.config.ts` so every server entry carries `bundle.plugins`.

### The server is assembled, never hand-written

[src/cli/commands/serve.ts](src/cli/commands/serve.ts) imports the generated `registry.ts` +
`domains.ts`, builds a name→`ModelDefinition` map, and mounts routers on one `App` in a
**registration-order-sensitive** sequence (most specific prefix first): `/api/auth`,
plugin prefixes (`/api/<segment>`, collisions with model names rejected at boot), `/api` (generic
`/api/:model`), then the console at `consolePath` (can be `/`),
then `/_site-assets`, then — when the consumer opts into `src/web/` — the `routes/` catch-all `/`.
Don't reorder without understanding the catch-all shadowing rules documented in that file.

### The router (`src/router/`) — no framework

[src/router/http-app.ts](src/router/http-app.ts) is a hand-rolled `App`/`Ctx` on the Fetch API
(`Request`/`Response`), replacing what used to be Hono. Route matching is a **linear scan in
registration order, first structural match wins** — deliberately not a trie, because routers rely on
order to disambiguate same-shaped dynamic routes (e.g. `POST /:model/:field/upload` vs
`POST /:model/:id/:operation`). `serveNode` is a minimal Node `http`→Fetch bridge for the
non-Bun deploy artifact. Tests hit routers via `app.request(path, init)`.

[src/router/create-router.ts](src/router/create-router.ts) is the generic `/api/:model` family:
CRUD + custom operations (`POST /:model/:id/:operation`), filtering, multi-column sort, cursor +
offset pagination, `?include=` relations. **Every route requires a matching `Permission` row by
default, reads included** (implicit `'read'` action); a model opts out with `api: { public: true }`.
Field-level access is secure-by-default (a `(resource, action)` grant with no `field` grant sees
zero fields).

### Models & pipelines (`src/core/`)

- [model.ts](src/core/model.ts) — `defineModel(table, { fields, operations?, console?, api? })`.
  `operations` beyond `create`/`update`/`remove` are custom operations (optionally with `params`
  and a `console` button config).
- [field.ts](src/core/field.ts) — the `field.*` DSL: `string`, `text`, `integer`, `decimal`,
  `boolean`, `datetime`, `enum`, `json` (zod schema), `reference`, `file` (flystorage-backed),
  `manyToMany`, `tree` (self-referencing hierarchy, one per model, cycle-checked on write),
  `custom(name, base)` (console input override).
- [pipeline.ts](src/core/pipeline.ts) — `pipe(...fns)` with a **write boundary**: `persist` /
  `persist.remove` / `persist.hardRemove` split the chain. Everything up to and including the
  boundary runs in one transaction (with an auto-prefetch of the existing row as the first
  statement for non-create ops); steps after it run post-commit, non-transactionally.
  `PipelineError` carries `{ code, status, fields? }`. `requireAuth`/`requirePermission` are applied
  by the router automatically — don't compose them into model pipelines by hand.

### Database drivers (`src/core/db.ts`, `db-client.ts`, `config.ts`)

`FrameworkConfig.db` is a `DbConfig` discriminated union on `driver` (`'sqlite'` | `'postgres'`,
mirroring `StorageConfig.driver`); `resolveDbConfig()` normalizes the pre-multi-driver
`{ connectionString }` shorthand to `driver: 'postgres'`. `AnyDb` (`db.ts`) is not a bare
`drizzle-orm` type — pg-core's `PgDatabase` and sqlite-core's `BaseSQLiteDatabase` share no common
raw-query method (`.execute()` vs `.all()`/`.run()`), so `AnyDb` wraps whichever real instance
`createDb()` (`db-client.ts`) builds behind one normalized `.execute()`/`.run()`/`.transaction()`
surface, with `.dialect` riding along on the same handle every function already threads through. A
hand-rolled deploy entry (Cloudflare/Vercel) that constructs its own drizzle client wraps it with
`wrapDb(rawDb, dialect)` before handing it to `createRatchetApp` — see `example/deploy/`.
`src/codegen/schema-gen.ts` is one dialect-parameterized emitter (not two files) for
`.ratchet/schema.ts`. See [ADR 0004](docs/adr/0004-sqlite-libsql-second-db-driver.md).

### Domains

A **Domain** groups related models into a console sidebar section with shared, DB-backed,
console-editable **Domain Settings** (read by pipelines at request time — distinct from static
`FrameworkConfig`). A model's Domain is **inferred from its top-level subdirectory** under
`modelsDir` (`models/auth/user.model.ts` → `auth`); no subdirectory → no Domain. See
[CONTEXT.md](CONTEXT.md) for the shared vocabulary and [docs/adr/](docs/adr/) for why (folder
inference: ADR 0001; DB-backed settings: ADR 0002).

### Plugins (`src/plugin/`, ADR 0006)

Feature packages plug in through `RatchetPlugin` (`ratchet.config.ts` → `plugins: [...]`):
models/domains/forms, `routes(ctx)`, `decorateDb`, `onSetup` (inside the first-admin tx),
`service`, `requires`/`optional`, console module(s) via the `ratchet:plugins` virtual module, and
Tailwind inputs. Plugins get a `PluginContext` whose `kit` holds core's persistence/access/query
helpers — plugin code must only import the public `@egig/ratchet/*` entry points, never `src/`
internals. `apiVersion` (`PLUGIN_API_VERSION`) gates compatibility; bump it when `PluginContext`
or `RatchetPlugin` change shape. The automation plugin (agents, chat, workflows) is
`@egig/ratchet-automation`, its own repo (sibling checkout `../ratchet-automation`, linked via
`link:@egig/ratchet`). `test/plugin-contract.test.ts` covers the contract with a fake plugin.

### Built-in feature packages

Each is a self-contained set of builtin models + a router + pipeline helpers, wired in by `createRatchetApp`:

| Path | What |
| --- | --- |
| `src/auth/` | better-auth (ADR 0005): User/Role/Session/Account/Verification models, `adapter.ts` (better-auth storage over `AnyDb`), `better-auth.ts` (fixed options + `FrameworkConfig.auth` passthrough), `/api/auth/*` (Ratchet's `/setup` + `/me`, the rest delegated to better-auth), session-token resolution, PBKDF2 hasher, `presetFields()` |
| `src/workspace/` | `Workspace` model + saved views; console screen with a plugin panel slot. `workspacePlugin` (always on) exposes a `snapshot` service other plugins soft-depend on. Slated for extraction into its own plugin |
| `src/web/` | the consumer's own `routes/**/*.tsx` React Router data-mode site — SSR + client bundle + the `/` catch-all; `/_site-assets/*` (`src/router/site-assets.ts`) serves public `field.file` Domain Settings values. There is no built-in `website` domain — `ratchet init` scaffolds `models/website/` (Page/Contact/settings) as consumer source. |

### Console client (`src/console/client/`)

React 19 + TanStack Query SPA on its own small browser-history router ([src/console/client/router.tsx](src/console/client/router.tsx) — first-match-in-order, not react-router; plugin console pages import its `Link`/`useNavigate`/... from `@egig/ratchet/console/client`), built by [src/cli/build-console.ts](src/cli/build-console.ts)
via `Bun.build` + Tailwind (framework bundles its own `@tailwindcss/cli`). There is **no per-app
entry file** — consumer extension points (`<model>.form.tsx`, `<model>.<field>.input.tsx` under
`modelsDir`) are pulled in through `ratchet:*` virtual-module specifiers that codegen populates.
All console UI icons come from [src/console/client/icons.ts](src/console/client/icons.ts) (Heroicons
20/solid re-export) — import from there, not `@heroicons/react` directly. `tailwindcss` must stay a
direct dependency (Bun 1.4 isolated linker won't hoist it for the CSS build).

## Contributing conventions

- Branch off `main`. Imperative-mood commit summaries ("Add field.tree() for ...").
- User-facing changes: update `docs/content/docs/` and add a `[Unreleased]` entry to
  [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog; mark breaking changes **Breaking:**). The docs
  Changelog page is generated from that file.
- `bun run typecheck` and `bun test` (with `DATABASE_URL` set) must pass.
- No React component tests — not the house style. Backend route-contract + serialization unit tests.
