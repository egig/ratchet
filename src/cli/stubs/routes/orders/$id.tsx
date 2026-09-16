import { data, Link, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

interface OrderRow {
  id: string;
  customerName: string;
  email: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  status: string;
  subtotal: string;
  shippingTotal: string;
  total: string;
}

interface OrderItemRow {
  id: string;
  productName: string;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

// A guest checkout has no account to sign into, so an order is looked up by its id alone — a
// uuidv7 (core/id.ts), unguessable the same way a password-reset token is. Treat this URL as the
// receipt: routes/checkout.tsx links here right after placing the order, and it's worth bookmarking.
export async function loader({ params, context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const [orderRows, itemRows] = await Promise.all([
    db.execute(
      sql`select id, customer_name as "customerName", email, address_line1 as "addressLine1", address_line2 as "addressLine2",
                 city, state, postal_code as "postalCode", country, status, subtotal, shipping_total as "shippingTotal", total
          from orders where id = ${params.id} and deleted_at is null limit 1`,
    ),
    db.execute(
      sql`select id, product_name as "productName", unit_price as "unitPrice", quantity, line_total as "lineTotal"
          from order_items where order_id = ${params.id} and deleted_at is null order by created_at asc`,
    ),
  ]);
  const order = (orderRows as unknown as OrderRow[])[0];
  if (!order) throw data('Not found', { status: 404 });
  return { order, items: itemRows as unknown as OrderItemRow[] };
}

export const meta = () => [{ title: 'Order confirmation' }];

export default function OrderConfirmation() {
  const { order, items } = useLoaderData<typeof loader>();

  return (
    <section className="page-section">
      <h1 className="page-h1">Thanks, {order.customerName.split(' ')[0]} — your order is in</h1>
      <p className="page-intro">
        A confirmation was sent to {order.email}. Order status: <span className="status-badge">{order.status}</span>
      </p>

      <div className="cart-layout">
        <div className="cart-lines">
          {items.map((item) => (
            <div key={item.id} className="cart-line">
              <div className="cart-line__info">
                <p className="cart-line__name">{item.productName}</p>
                <p className="muted">
                  ${Number(item.unitPrice).toFixed(2)} × {item.quantity}
                </p>
              </div>
              <div className="cart-line__total">${Number(item.lineTotal).toFixed(2)}</div>
            </div>
          ))}
        </div>

        <div className="cart-summary">
          <div className="summary-row">
            <span>Subtotal</span>
            <span>${Number(order.subtotal).toFixed(2)}</span>
          </div>
          <div className="summary-row">
            <span>Shipping</span>
            <span>${Number(order.shippingTotal).toFixed(2)}</span>
          </div>
          <div className="summary-row summary-row--total">
            <span>Total</span>
            <span>${Number(order.total).toFixed(2)}</span>
          </div>
          <p className="muted" style={{ marginTop: '1.25rem' }}>
            Shipping to
            <br />
            {order.addressLine1}
            {order.addressLine2 ? <>, {order.addressLine2}</> : null}
            <br />
            {order.city}, {order.state} {order.postalCode}
            <br />
            {order.country}
          </p>
        </div>
      </div>

      <p style={{ marginTop: '2.5rem' }}>
        <Link to="/shop" className="link-btn">
          ← Continue shopping
        </Link>
      </p>
    </section>
  );
}
