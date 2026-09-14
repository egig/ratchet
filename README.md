<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.png">
    <img src="docs/public/logo.png" alt="Ratchet" width="120">
  </picture>
</p>

<h1 align="center">Ratchet</h1>

<p align="center">Model driven application framework: TypeScript models -> SQLite/Postgres schema, codegen, and composable pipelines.</p>

Ratchet turns a directory of TypeScript model files into a SQLite or Postgres schema, a REST API, a console, and auth — with composable pipelines wherever you need custom logic.

## Install

```sh
bun add @egig/ratchet
```

## Prerequisites

- [Bun](https://bun.sh) 1.3+

That's it — a new project defaults to a local SQLite file, created automatically. No database to install. Postgres and hosted [Turso](https://turso.tech) are supported too — see `docs/content/docs/database.mdx`.

## Scaffold a project

```sh
bunx @egig/ratchet init
```

This writes `package.json`, `tsconfig.json`, `ratchet.config.ts`, `models/example.model.ts`, `migrations`, and a `.gitignore` into the current directory. It never overwrites a file that's already there, so it's safe to re-run in a partially set-up directory.

## Define a model

```ts
import { defineModel, field } from '@egig/ratchet/core';

export const Example = defineModel('examples', {
  fields: {
    name: field.string({ required: true, maxLength: 255 }),
  },
});
```

## Generate, migrate, serve

```sh
bun run generate   # regenerate .ratchet/*, then drizzle-kit generate -> SQL migration files
bun run migrate    # drizzle-kit migrate — apply the pending SQL migration files
bun run serve       # boot the API + console
```

`ratchet serve` reads `ratchet.config.ts` and the generated registry and boots a listening server. It mounts, in order:

- `/api/auth/*` — register/login/logout/me
- `/api/:model` — the generic REST router, one route family for every model (filtering, sorting, cursor and offset pagination, `?include=` relations)
- `/console` — the generated console SPA

## Documentation

Full guides (models & fields, pipelines, the REST API, CLI reference) are in [`docs/`](./docs).

## License

MIT
