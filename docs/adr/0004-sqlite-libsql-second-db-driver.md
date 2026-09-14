# SQLite (via libsql) is a second database driver, and the default for `ratchet init`

Every new project scaffolded by `ratchet init` used to require a running Postgres instance before
anything worked — a real barrier for trying the framework or building something small. We added
SQLite as a second, fully-supported driver and made it the default for `ratchet init`; Postgres
stays fully supported for existing/production projects, selected explicitly via
`db: { driver: 'postgres', connectionString }` in `ratchet.config.ts`. This is a per-project
choice, not a framework-wide default — the two drivers are otherwise equal citizens.

We chose `@libsql/client`/`drizzle-orm/libsql` over `better-sqlite3` or Bun's built-in `bun:sqlite`.
`ratchet build` emits a plain-Node server artifact, while `ratchet serve`/`dev`/tests run under
Bun — `bun:sqlite` only works in the latter, and `better-sqlite3` needs a native compile step that
occasionally causes CI/platform friction. `@libsql/client` works identically in both runtimes with
no native dependency, and — because `drizzle-kit`'s `turso` dialect's `dbCredentials` shape
(`{ url, authToken? }`) is exactly what `@libsql/client` itself takes — a project can move from a
local `file:./local.db` to hosted [Turso](https://turso.tech) later by changing `url`/`authToken`
in config alone, no driver swap, no code change.

Consequences worth knowing:

- `FrameworkConfig.db` is a discriminated union (`DbConfig`, `src/core/config.ts`) keyed by
  `driver`, mirroring the existing `StorageConfig.driver` pattern. The pre-existing
  `{ connectionString }` shorthand (no `driver` key) still works, normalized to `driver: 'postgres'`
  by `resolveDbConfig()` — no migration needed for an existing hand-written `ratchet.config.ts`.
- `AnyDb` (`src/core/db.ts`) is no longer a bare `drizzle-orm` type alias. pg-core's `PgDatabase`
  and sqlite-core's `BaseSQLiteDatabase` (which `LibSQLDatabase` extends) share no common raw-query
  method — pg-core has `.execute()` returning a bare row array, sqlite-core has
  `.all()`/`.get()`/`.run()`/`.values()` instead, no `.execute()` at all. `AnyDb` wraps whichever
  real drizzle instance `createDb` (`src/core/db-client.ts`) builds behind one normalized
  `.execute()`/`.run()`/`.transaction()` surface, with `dialect` riding along as a property on the
  same handle every function already threads through — so the ~30 functions across
  `core/persistence.ts`, `core/tree.ts`, `core/domain-settings-persistence.ts`, `auth/lookup.ts`,
  and `router/list.ts` that run raw `sql` queries needed no second `dialect` parameter threaded
  through their signatures.
- `src/codegen/schema-gen.ts` is one dialect-parameterized emitter, not two separate files — the
  structural codegen (table/index/constraint assembly) is identical between dialects; only the
  per-`FieldDefinition.kind` column-builder mapping and the import block differ. Notable mappings:
  `string`/`enum`/`modelRef` etc. → `text` (sqlite-core has no `varchar`); `boolean` →
  `integer({mode:'boolean'})` (no native boolean type); `datetime` → `text({mode:'string'})` storing
  the same ISO-8601 UTC string Postgres's `timestamptz` already normalizes to, not
  `integer({mode:'timestamp'})` (which loses sub-second precision by default); `reference`/`tree`/id
  columns → `text` (no `uuid` builder — unproblematic since ids are always app-generated `uuidv7()`
  strings, never DB-generated). `maxLength`/decimal `precision`/`scale` become advisory
  (Zod-validation-only) under SQLite rather than DB-enforced, same as they already are for anything
  beyond what Postgres itself checks.
- A handful of Postgres-only SQL constructs needed a SQLite-portable rewrite: the `ilike` filter
  operator (`ILIKE` → `LOWER() LIKE LOWER()`), `hasRootAdmin`'s jsonb `@>` containment check (→
  `json_each`/`json_extract`), and cursor pagination's row-value tuple comparison
  `(a, b) > (x, y)` (SQLite doesn't support the syntax at all → the equivalent boolean-expansion
  form, which is valid on Postgres too, so it replaced the tuple form outright rather than being
  dialect-branched). `RETURNING` and `ON CONFLICT ... DO UPDATE ... EXCLUDED` needed no changes —
  both dialects support near-identical syntax.
