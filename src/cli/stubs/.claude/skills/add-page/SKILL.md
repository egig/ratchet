---
name: add-page
description: Add or change a public website page in this Ratchet app (routes/*.tsx, React Router). Use when the user wants a new page, a list or detail page showing model data, a form visitors submit, or a change to the site header/footer/layout.
---

# Add or change a website page

Follow the "Add a page" recipe in `AGENTS.md`.

1. **Choose the file.** The file path is the URL:
   - `routes/about.tsx` is `/about`.
   - `routes/events/index.tsx` is `/events`.
   - `routes/events/$slug.tsx` is `/events/:slug`.
   - Don't add `routes/events.tsx` next to an `events/` folder; it would become a layout.
2. **Load data in `loader`** with `getWebContext(context).db` and `sql\`...\``.
   - Use snake_case columns, always filter `deleted_at is null`, and only select published or
     visible rows.
   - Write SQL that runs on both SQLite and Postgres.
   - For a missing record, `throw new Response('Not found', { status: 404 })`.
3. **Forms.** Export an `action`. Validate the input there and return field errors. Write with
   `db.execute(sql\`insert ...\`)`, supplying `id` (`crypto.randomUUID()`), `created_at` and
   `updated_at` (`new Date().toISOString()`). For a full working example, see
   `routes/contact.tsx`.
4. **Title and SEO.** Export `meta = () => [{ title: '...' }]`.
5. **Style.** Reuse the classes in `public/theme.css` and the structure of existing routes. Don't
   add a CSS framework unless asked.
6. **Navigation.** Header and footer links live in `routes/root.tsx`. Content pages created in
   the console can also opt into the nav.
7. **Verify.** Run `bun run check`, then open the page at http://localhost:3000/... while
   `bun run dev` runs.
