# Ratchet

Ratchet is a backend framework where a declared `Model` drives the Postgres table, REST routes, validation, and console admin UI. This file captures the vocabulary the framework and consumer apps share.

## Language

**Model**:
A single declarative unit (`defineModel()`) that owns one Postgres table, its fields, and its create/update/remove pipelines. Drives the REST API and console UI for that table.

**Domain**:
A named grouping of related Models that share a console sidebar section and a set of Domain Settings — e.g. `auth` groups the User/Role/Session/Account/Verification models. A Model's Domain is inferred from the top-level subdirectory it's declared in under `modelsDir` (`models/auth/*.model.ts` → domain `auth`); a Model declared directly under `modelsDir`, with no subdirectory, belongs to no Domain. Framework built-in models are assigned a Domain explicitly, since they aren't scanned from the app's `modelsDir`.
_Avoid_: Module, Feature, Package

**Domain Settings**:
A typed, DB-backed, console-editable set of values scoped to one Domain, read by that Domain's business logic (pipeline functions) at request time. Distinct from `FrameworkConfig`, which is static and baked in at build/deploy time.
_Avoid_: Runtime settings, Config, Feature flags
