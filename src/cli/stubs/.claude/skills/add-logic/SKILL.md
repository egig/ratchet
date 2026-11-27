---
name: add-logic
description: Add business rules or actions to a Ratchet model — validation beyond field types, computed values, side effects after saving, or a named action button (approve, archive, cancel). Use when the user says "when X is saved, do Y", "don't allow X unless Y", or "add a button that ...".
---

# Add business logic or an action

Follow the "Add custom logic" and "Add a button / action" recipes in `AGENTS.md`.

1. **Rule on create/update?** Write a `PipelineFn` and put it before `validate` in
   `operations: { create: pipe(myRule, validate, persist), update: pipe(myRule, validate, persist) }`.
   - To reject, throw
     `new PipelineError({ code: 'VALIDATION_ERROR', status: 400, fields: { field: 'reason' } })`.
   - To change data, return `{ ...ctx, input: { ...ctx.input, field: newValue } }`.
2. **Side effect after saving** (email, webhook, log)? Put it after `persist`:
   `pipe(validate, persist, notify)`. It runs once the save is committed. If it throws, the save
   is not undone.
3. **A named action/button?** Add a custom operation:
   - Use `presetFields({ field: value })` for "set these fields".
   - Use `pipe(check, presetFields(...))` to guard it.
   - Add `console: { label, confirm?, visibleWhen? }` so it shows as a button.
   - For a complete example (status guards, restocking inside the transaction), see
     `models/shop/order.model.ts`.
4. **Shared code** goes in `logic/<name>.ts`. Import it with a `.js` extension.
5. **Never** add `requireAuth` or `requirePermission` to a pipeline; the API applies them.
6. **Verify.** Run `bun run check`. Then try the action in the console (as the admin) to confirm
   the rule fires.
