import { defineModel, field } from '@egig/ratchet/core';

/**
 * A sellable item. `price`/`compareAtPrice` are decimal strings (e.g. "129.99") — see
 * [Custom Operations](/guide/custom-operations) and `core/validation.ts`'s Q24 for why decimals
 * round-trip as strings, never JS `number`, to preserve precision. `stock` is decremented at
 * checkout (routes/checkout.tsx) inside the same transaction that inserts the order, and restored
 * by Order's `cancel` operation (models/shop/order.model.ts) — never edited by any other write path.
 *
 * There's no real image upload here on purpose: `field.file()`'s public, unauthenticated read path
 * only exists for Domain Settings (`FileFieldDefinition.public`, core/field.ts) — a model field like
 * this one is always gated behind that model's own `read` permission, which would 401 for an
 * anonymous storefront visitor. Until the framework grows a public file-serving story for model
 * fields, `imageLabel` drives the placeholder swatch the storefront renders instead (see
 * `public/theme.css`'s `.swatch`).
 */
export const Product = defineModel('products', {
  fields: {
    name: field.string({ required: true, maxLength: 255 }),
    slug: field.string({ required: true, unique: true, indexed: true, maxLength: 255 }),
    description: field.text({ required: false }),
    sku: field.string({ required: true, unique: true, indexed: true, maxLength: 64, displayText: 'SKU' }),
    price: field.decimal({ precision: 10, scale: 2, required: true }),
    compareAtPrice: field.decimal({
      precision: 10,
      scale: 2,
      required: false,
      displayText: 'Compare-at price',
      description: 'The pre-discount price, shown struck through next to the real price. Leave blank when not on sale.',
    }),
    stock: field.integer({ default: 0, description: 'Units available. Decremented at checkout, restored if an order is cancelled.' }),
    status: field.enum(['draft', 'active', 'archived'] as const, {
      default: 'draft',
      indexed: true,
      description: 'Only "active" products with stock appear on the storefront.',
    }),
    categoryId: field.reference('categories', { required: false, indexed: true }),
    imageLabel: field.string({
      required: false,
      maxLength: 120,
      displayText: 'Image placeholder text',
      description: 'Short caption shown on the product tile in place of a real product photo.',
    }),
    featured: field.boolean({ default: false, indexed: true, description: 'Featured products are highlighted on the homepage.' }),
  },
  console: { label: 'Products', displayField: 'name' },
});
