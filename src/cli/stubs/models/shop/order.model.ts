import { defineModel, field, persist, pipe, validate, PipelineError, type PipelineFn } from '@egig/ratchet/core';
import { presetFields } from '@egig/ratchet/auth';
import { sql } from 'drizzle-orm';

/** Blocks `status` from a plain `update` — the only paths that may change it are `markPaid`/
 * `markFulfilled`/`cancel` below, mirroring `workspaces`' own `locked`/`forbidLockedInUpdate`
 * pattern (models/workspace.model.ts): one field, one dedicated set of operations, so there's
 * exactly one permission pair (`resource:markPaid`, not `resource:update` + `field:status`) that
 * can move an order through its lifecycle. */
const forbidStatusInUpdate: PipelineFn = (ctx) => {
  if ('status' in ctx.input) {
    throw new PipelineError({
      code: 'VALIDATION_ERROR',
      status: 400,
      fields: { status: "can't be set via update — use the markPaid/markFulfilled/cancel operation instead" },
    });
  }
  return ctx;
};

/** Rejects a status-changing operation unless the order is currently in one of `allowed` — e.g.
 * `cancel` only makes sense from "pending" or "paid", never from "fulfilled". Must run before
 * `presetFields` so a stale/repeated click (the console has no optimistic locking) fails loudly
 * instead of silently re-applying. */
function assertStatus(allowed: readonly string[]): PipelineFn {
  return (ctx) => {
    if (!allowed.includes(ctx.doc?.status as string)) {
      throw new PipelineError({
        code: 'INVALID_STATE',
        status: 400,
        message: `order must be ${allowed.join(' or ')} to do this (currently "${ctx.doc?.status}")`,
      });
    }
    return ctx;
  };
}

/** Restores each line item's quantity back onto its product's `stock` — the inverse of the
 * decrement routes/checkout.tsx does at order creation. Runs on `ctx.db`, which inside a custom
 * operation's own `pipe()` is the enclosing transaction, so a cancel is all-or-nothing with the
 * status write `presetFields` performs right after it. */
const restockOrderItems: PipelineFn = async (ctx) => {
  if (!ctx.id) return ctx;
  const items = await ctx.db.execute(
    sql`select product_id as "productId", quantity from order_items where order_id = ${ctx.id} and deleted_at is null`,
  );
  for (const item of items as unknown as { productId: string; quantity: number }[]) {
    await ctx.db.execute(sql`update products set stock = stock + ${item.quantity} where id = ${item.productId}`);
  }
  return ctx;
};

/**
 * A checkout — created directly by routes/checkout.tsx (raw SQL through `context.db`, alongside its
 * `order_items` rows, in one transaction), never through this model's own `create` operation: like
 * `contacts` (models/website/contact.model.ts), there's no public write API, so guest checkout
 * doesn't need one. This model's `operations` exist for the console: browsing orders, and moving one
 * through its lifecycle with `markPaid` / `markFulfilled` / `cancel` instead of a raw status edit —
 * each gates the underlying `status` write through `presetFields`'s normal field-permission check
 * (see `ratchet/auth`), so granting `orders:markPaid` alone doesn't imply a raw `orders:update`.
 *
 * Line items live on the separate `order_items` model (models/shop/order-item.model.ts), each
 * pointing back here via its own `orderId` — browse them filtered by order, the same one-to-many
 * shape `workspace_views` uses for `workspaces` (see that model's own doc comment for why this
 * framework prefers a plain FK over `field.referenceToMany()` here).
 */
export const Order = defineModel('orders', {
  fields: {
    customerName: field.string({ required: true, maxLength: 255 }),
    email: field.string({ required: true, maxLength: 320 }),
    addressLine1: field.string({ required: true, maxLength: 255, displayText: 'Address' }),
    addressLine2: field.string({ required: false, maxLength: 255, displayText: 'Address line 2' }),
    city: field.string({ required: true, maxLength: 120 }),
    state: field.string({ required: true, maxLength: 120 }),
    postalCode: field.string({ required: true, maxLength: 20, displayText: 'Postal code' }),
    // No `default` here alongside `required: true` — `field.ts` rejects that combination (a
    // required field is never absent, so a default is contradictory). routes/checkout.tsx always
    // supplies a value, falling back to "US" itself before the insert.
    country: field.string({ required: true, maxLength: 2, description: 'ISO 3166-1 alpha-2 country code.' }),
    status: field.enum(['pending', 'paid', 'fulfilled', 'cancelled'] as const, { default: 'pending', indexed: true }),
    subtotal: field.decimal({ precision: 10, scale: 2, required: true }),
    shippingTotal: field.decimal({ precision: 10, scale: 2, default: '0.00', displayText: 'Shipping' }),
    total: field.decimal({ precision: 10, scale: 2, required: true }),
    notes: field.text({ required: false, description: 'Notes the customer left at checkout.' }),
  },
  operations: {
    update: pipe(forbidStatusInUpdate, validate, persist),
    markPaid: {
      pipeline: pipe(assertStatus(['pending']), presetFields({ status: 'paid' })),
      description: 'Mark this order as paid.',
      console: { label: 'Mark as paid', visibleWhen: { field: 'status', equals: 'pending' } },
    },
    markFulfilled: {
      pipeline: pipe(assertStatus(['paid']), presetFields({ status: 'fulfilled' })),
      description: 'Mark this paid order as shipped/fulfilled.',
      console: { label: 'Mark as fulfilled', visibleWhen: { field: 'status', equals: 'paid' } },
    },
    cancel: {
      pipeline: pipe(assertStatus(['pending', 'paid']), restockOrderItems, presetFields({ status: 'cancelled' })),
      description: 'Cancel this order and restore its items to stock.',
      console: { label: 'Cancel order', confirm: 'Cancel this order and restock its items?', visibleWhen: { field: 'status', in: ['pending', 'paid'] } },
    },
  },
  console: { label: 'Orders', displayField: 'customerName' },
});
