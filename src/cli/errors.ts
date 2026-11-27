/**
 * Turns a thrown error into what a beginner (or the coding agent driving the project) needs: what
 * went wrong, and one concrete next step. The message itself stays verbatim — it already names the
 * model/field/file — `hint` only adds the "how to fix" the raw message leaves implicit.
 */
interface Hint {
  match: RegExp;
  hint: string;
}

const HINTS: Hint[] = [
  {
    match: /drizzle-kit push reported a database error/,
    hint: "The model change couldn't be applied to the dev database as-is (common cause: a new required field on a table that already has rows; give it a default or make it optional). If the local data is disposable, stop dev, delete local.db, and start dev again.",
  },
  {
    match: /references unknown model '/,
    hint: "The first argument to field.reference()/manyToMany() is the target's table name (the string passed to defineModel, e.g. 'products'), not its export name.",
  },
  {
    match: /duplicate model name '/,
    hint: 'Rename one of the two defineModel() table names — each must be unique across models/.',
  },
  {
    match: /must live under 'models\//,
    hint: 'Move the settings.domain.ts file into the folder named after the Domain.',
  },
  {
    match: /both 'required: true' and a 'default'/,
    hint: "Drop 'required: true' (the default already guarantees a value) or drop the default.",
  },
  {
    match: /is a reserved operation name/,
    hint: 'Pick another name for the custom operation (create, update, remove, read, query and upload are reserved).',
  },
  {
    match: /ratchet\.config\.ts/,
    hint: "Run this command from the project root (the folder with ratchet.config.ts), or run 'bunx @egig/ratchet init' to create one.",
  },
  {
    match: /Cannot find module|Cannot find package/,
    hint: "Run 'bun install'. If the import is your own file, check the path and the .js extension (TypeScript NodeNext imports use .js).",
  },
  {
    match: /seed: invalid row/,
    hint: 'Fix the listed fields in seed.ts so they match the model definition.',
  },
  {
    match: /SQLITE_ERROR|no such table|relation ".*" does not exist/,
    hint: "The database schema is behind your models. In development run 'bun run dev' (it syncs automatically); otherwise 'bun run generate && bun run migrate'.",
  },
  {
    match: /EADDRINUSE/,
    hint: 'Another process is using the port. Stop it, or set PORT=3001 (any free port).',
  },
];

export function hintFor(message: string): string | undefined {
  return HINTS.find((h) => h.match.test(message))?.hint;
}

/** One printable block: `error: <message>` plus an optional `fix: <hint>` line. */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintFor(message);
  return hint ? `error: ${message}\nfix:   ${hint}` : `error: ${message}`;
}
