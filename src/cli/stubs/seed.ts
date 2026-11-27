import { sql } from 'drizzle-orm';
import { defineSeed } from '@egig/ratchet/core';
import { Category } from './models/shop/category.model.js';
import { Product } from './models/shop/product.model.js';
import { Page } from './models/website/page.model.js';

/**
 * Sample data, so the site and console aren't empty on first run. `bun run dev` runs this after
 * every schema sync, and `bun run seed` runs it on demand.
 *
 * Each block is guarded by `isEmpty`, so it only inserts into an empty table. Restarting never
 * duplicates rows, and anything you've edited in the console is left alone. Keep one independent
 * block per model: if a table is ever emptied, its block refills it on the next sync without
 * touching the others. `insert` validates each row against the model (same rules as the API) and
 * fails with the field named if a value is wrong.
 *
 * Adding a model? Add a guarded block for it here too.
 */
export default defineSeed(async ({ db, insert, isEmpty }) => {
  if (await isEmpty(Category)) {
    await insert(Category, { name: 'Apparel', slug: 'apparel', description: 'Everyday basics, made to last.', imageLabel: 'Folded tees', sortOrder: 1 });
    await insert(Category, { name: 'Home', slug: 'home', description: 'Small things that make a room.', imageLabel: 'Ceramic mugs', sortOrder: 2 });
  }

  if (await isEmpty(Product)) {
    // Look categories up by slug rather than reusing ids from the block above, so this block still
    // works when only the products table is empty.
    const rows = (await db.execute(sql`select id, slug from categories where deleted_at is null`)) as unknown as { id: string; slug: string }[];
    const categoryId = (slug: string) => rows.find((r) => r.slug === slug)?.id ?? null;

    const products = [
      { name: 'Classic Tee', slug: 'classic-tee', sku: 'TEE-001', price: '24.00', stock: 40, categoryId: categoryId('apparel'), imageLabel: 'White tee', featured: true },
      { name: 'Canvas Tote', slug: 'canvas-tote', sku: 'TOTE-001', price: '18.00', compareAtPrice: '22.00', stock: 25, categoryId: categoryId('apparel'), imageLabel: 'Natural tote' },
      { name: 'Stoneware Mug', slug: 'stoneware-mug', sku: 'MUG-001', price: '16.00', stock: 60, categoryId: categoryId('home'), imageLabel: 'Speckled mug', featured: true },
      { name: 'Linen Napkins (set of 4)', slug: 'linen-napkins', sku: 'NAP-004', price: '32.00', stock: 15, categoryId: categoryId('home'), imageLabel: 'Folded linen' },
    ];
    for (const p of products) {
      await insert(Product, { ...p, status: 'active', description: `Sample product: ${p.name}. Edit or delete it in the console.` });
    }
  }

  if (await isEmpty(Page)) {
    await insert(Page, {
      slug: 'about',
      title: 'About',
      body: '<p>This is a sample page. Edit it in the console under Pages, or delete it.</p>',
      status: 'published',
      navLocation: 'header',
      navOrder: 1,
    });
  }
});
