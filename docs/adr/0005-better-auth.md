# Authentication is better-auth, stored through Ratchet's own models and adapter

Ratchet shipped hand-rolled auth: email/password only, a `password_hash` column on `users`, an
opaque session token in a `ratchet_session` cookie. Every feature a starter kit is expected to have
beyond that (social sign-in, email verification, password reset, rate limiting, session
management, 2FA) would have been more hand-rolled security code. We replaced the session and
credential layer with [better-auth](https://www.better-auth.com) and kept Ratchet's own
authorization (roles, the `permissions` tree, field grants, ownership scope), which better-auth
doesn't model.

Decisions, and why:

- **better-auth's tables are ordinary Ratchet models** (`User`, `Session`, `Account`,
  `Verification` in `src/auth/models/`), so `ratchet generate` migrates them, they carry the usual
  system columns, and `User` stays a normal, permission-gated model in the console and API.
- **A custom adapter over `AnyDb`** (`src/auth/adapter.ts`), not better-auth's drizzle adapter.
  `createRatchetApp` and the deploy templates only receive an `AnyDb`; the drizzle adapter would
  also need the raw drizzle instance and the generated table objects. The custom adapter also
  skips soft-deleted rows, snake-cases names, and keeps Ratchet's ISO-string datetime convention
  on both dialects. It runs non-transactionally, like the drizzle adapter's default: a wrapping
  transaction deadlocks local SQLite when better-auth issues a statement outside it.
- **Session checks outside `/api/auth` read `sessions` directly** (`resolveSessionUser`), rather
  than calling `auth.api.getSession`. Those checks run on whatever `AnyDb` handle is in hand,
  often a pipeline's transaction, with no reference to the better-auth instance. The cookie's HMAC
  is stripped, not verified: the token is the secret and must exist in `sessions`. The cookie
  prefix is pinned to `ratchet` so this resolution needs no config. `/api/auth/me` does use
  `getSession`, so console page loads still refresh sliding sessions.
- **The PBKDF2 hasher is kept** (`emailAndPassword.password`), so existing hashes verify after the
  data migration and hashing stays Web-Crypto-only on Node, Bun, and Workers.
- **`roleId`/`active` are better-auth `additionalFields` with `input: false`**, so no public
  endpoint can set them. A `session.create.before` hook blocks inactive users.
- **`FrameworkConfig.auth` is better-auth's options, passed through**, minus what Ratchet must own
  (adapter, base path, cookie prefix, id generator, hasher, user fields, `bearer` plugin).

Consequences:

- Breaking for API clients: `/register`, `/login`, `/logout`, and `PATCH /me` are gone in favour
  of better-auth's endpoints; error bodies there are `{ code, message }`.
- Breaking for existing databases: `users.password_hash` moves to `accounts.password`, which needs
  a hand-edited data step in the generated migration (docs/content/docs/auth.mdx).
- better-auth plugins that add columns to `user`/`session`/`account` (two-factor, admin,
  organization, ...) aren't usable until built-in models can be extended. Plugins that only add
  tables work with a consumer-declared model per table.
