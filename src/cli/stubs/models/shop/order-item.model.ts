import { defineModel, field } from '@egig/ratchet/core';

/**
 * One line of an `Order` (models/shop/order.model.ts), created alongside it by
 * routes/checkout.tsx's raw-SQL transaction — never through this model's own `create` operation.
 * `productName`/`unitPrice` are snapshotted at checkout time rather than read live through
 * `productId`, so a later price change or rename never rewrites the history of what was actually
 * charged.
 */
export const OrderItem = defineModel('order_items', {
  fields: {
    orderId: field.reference('orders', { required: true, indexed: true, displayText: 'Order' }),
    productId: field.reference('products', { required: true, indexed: true, displayText: 'Product' }),
    productName: field.string({ required: true, maxLength: 255, displayText: 'Product name' }),
    unitPrice: field.decimal({ precision: 10, scale: 2, required: true, displayText: 'Unit price' }),
    quantity: field.integer({ required: true }),
    lineTotal: field.decimal({ precision: 10, scale: 2, required: true, displayText: 'Line total' }),
  },
  console: { label: 'Order items', displayField: 'productName' },
});
