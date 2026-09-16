import { defineModel, field } from '@egig/ratchet/core';

/**
 * A shop category — optionally nested (field.tree()) so a category can have sub-categories, e.g.
 * "Kits" under "Templates". `imageLabel` is a short placeholder caption (not a real photo — see
 * Product's own `imageLabel` for why) shown on the category's tile on routes/categories.tsx.
 */
export const Category = defineModel('categories', {
  fields: {
    name: field.string({ required: true, maxLength: 255 }),
    slug: field.string({ required: true, unique: true, indexed: true, maxLength: 255 }),
    description: field.text({ required: false }),
    imageLabel: field.string({
      required: false,
      maxLength: 120,
      displayText: 'Image placeholder text',
      description: 'Short caption shown on the category tile in place of a real product photo.',
    }),
    parentId: field.tree({ displayText: 'Parent category' }),
    status: field.enum(['visible', 'hidden'] as const, {
      default: 'visible',
      indexed: true,
      description: 'Hidden categories are still editable but never appear on the storefront.',
    }),
    sortOrder: field.integer({ default: 0, displayText: 'Sort order' }),
  },
  console: { label: 'Categories', displayField: 'name' },
});
