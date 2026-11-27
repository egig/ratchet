---
name: add-model
description: Add or change a data model (a database table with its API and admin screens) in this Ratchet app. Use when the user wants to store a new kind of thing ("track customers", "add a blog", "products need a color"), add or change fields, or relate two models.
---

# Add or change a model

Follow the "Add a model" recipe and the Rules in `AGENTS.md`.

1. **Pick the folder.** The folder under `models/` is the admin sidebar section. Reuse an
   existing one when the model fits (`shop`, `website`). Otherwise create a new folder.
2. **Write `models/<folder>/<name>.model.ts`.**
   - Use one `defineModel('<plural_snake_table>', { fields, console: { label, displayField } })`.
   - Give each field that a non-technical admin will see a `displayText` and a `description`.
3. **Relations.** Use `field.reference('<table>')` for many-to-one. Use
   `field.manyToMany('<table>')` for tags-style links. Use `field.tree()` for parent/child within
   one model. Always use table names, not export names.
4. **Changing an existing model?**
   - Removing a field, renaming it, or narrowing its type deletes that column's data in dev.
   - A new `required: true` field with no `default` empties the whole table if it already has
     rows. Add a `default` or keep the field optional.

   For any of these, tell the user and get a yes first.
5. **Seed it.** Add a block to `seed.ts`, wrapped in `if (await isEmpty(Model)) { ... }`, with
   2 to 4 realistic rows.
6. **Show it publicly?** If visitors should see this data, use the `add-page` skill. Don't make
   the API public just for a page.
7. **Verify.** Run `bun run check` until it prints `all checks passed.` If `bun run dev` is
   running, check its output for an `error:` line after the save.

Tell the user where to find it: Console, then the section name, then the label.
