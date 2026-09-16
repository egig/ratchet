import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { clearCartCookieHeader, hydrateCartLines, readCart } from '../logic/cart.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FREE_SHIPPING_THRESHOLD = 75;
const FLAT_SHIPPING_RATE = 9.99;

function shippingFor(subtotal: number): number {
  return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING_RATE;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const lines = await hydrateCartLines(db, readCart(request));
  const subtotal = lines.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);
  return { lines, subtotal, shipping: shippingFor(subtotal) };
}

/** Runs the whole checkout as one transaction: re-derives cart lines from the live `products` table
 * (never trusting the cart cookie's price/name), then decrements each line's stock with a guarded
 * `UPDATE ... WHERE stock >= quantity RETURNING id` — if that returns no row, a concurrent order beat
 * this one to the last unit and the whole transaction (order + items alike) rolls back. There's no
 * `SELECT ... FOR UPDATE` here: `numeric`/row-locking syntax isn't portable across the sqlite and
 * postgres drivers this framework supports (ADR 0004), so the guarded UPDATE is the atomicity
 * boundary instead. No payment processor is wired up — every order lands as "pending" for an admin
 * to mark paid (Order's `markPaid` operation) once payment is collected out of band.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const { db } = getWebContext(context);
  const form = await request.formData();

  const values = {
    customerName: String(form.get('customerName') ?? '').trim(),
    email: String(form.get('email') ?? '').trim(),
    addressLine1: String(form.get('addressLine1') ?? '').trim(),
    addressLine2: String(form.get('addressLine2') ?? '').trim(),
    city: String(form.get('city') ?? '').trim(),
    state: String(form.get('state') ?? '').trim(),
    postalCode: String(form.get('postalCode') ?? '').trim(),
    country: (String(form.get('country') ?? 'US').trim().toUpperCase() || 'US').slice(0, 2),
    notes: String(form.get('notes') ?? '').trim(),
  };

  const errors: Record<string, string> = {};
  if (!values.customerName) errors.customerName = 'Please enter your name.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Please enter a valid email address.';
  if (!values.addressLine1) errors.addressLine1 = 'Please enter an address.';
  if (!values.city) errors.city = 'Please enter a city.';
  if (!values.state) errors.state = 'Please enter a state/province.';
  if (!values.postalCode) errors.postalCode = 'Please enter a postal code.';
  if (Object.keys(errors).length > 0) return { ok: false as const, errors, values };

  try {
    const orderId = await db.transaction(async (tx) => {
      const cartLines = readCart(request);
      const lines = await hydrateCartLines(tx, cartLines);
      if (lines.length === 0) {
        throw new Error('Your cart is empty, or everything in it is now out of stock.');
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const subtotal = lines.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);
      const shippingTotal = shippingFor(subtotal);
      const total = subtotal + shippingTotal;

      await tx.execute(
        sql`insert into orders
              (id, created_at, updated_at, customer_name, email, address_line1, address_line2, city, state, postal_code, country,
               status, subtotal, shipping_total, total, notes)
            values
              (${id}, ${now}, ${now}, ${values.customerName}, ${values.email}, ${values.addressLine1}, ${values.addressLine2 || null},
               ${values.city}, ${values.state}, ${values.postalCode}, ${values.country},
               'pending', ${subtotal.toFixed(2)}, ${shippingTotal.toFixed(2)}, ${total.toFixed(2)}, ${values.notes || null})`,
      );

      for (const line of lines) {
        const updated = await tx.execute(
          sql`update products set stock = stock - ${line.quantity} where id = ${line.id} and stock >= ${line.quantity} returning id`,
        );
        if ((updated as unknown[]).length === 0) {
          throw new Error(`"${line.name}" no longer has enough stock — please update your cart and try again.`);
        }
        await tx.execute(
          sql`insert into order_items (id, created_at, updated_at, order_id, product_id, product_name, unit_price, quantity, line_total)
              values (${crypto.randomUUID()}, ${now}, ${now}, ${id}, ${line.id}, ${line.name}, ${line.price}, ${line.quantity},
                      ${(Number(line.price) * line.quantity).toFixed(2)})`,
        );
      }

      return id;
    });

    return redirect(`/orders/${orderId}`, { headers: { 'Set-Cookie': clearCartCookieHeader() } });
  } catch (err) {
    return { ok: false as const, errors: { cart: err instanceof Error ? err.message : 'Something went wrong placing your order.' }, values };
  }
}

export const meta = () => [{ title: 'Checkout' }];

export default function Checkout() {
  const { lines, subtotal, shipping } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state === 'submitting';
  const errors: Record<string, string> = result && !result.ok ? result.errors : {};
  const values = result && !result.ok ? result.values : { customerName: '', email: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: 'US', notes: '' };

  if (lines.length === 0) {
    return (
      <section className="page-section">
        <h1 className="page-h1">Checkout</h1>
        <p>Your cart is empty.</p>
        <Link to="/shop" className="button button--primary">
          Continue shopping
        </Link>
      </section>
    );
  }

  return (
    <section className="page-section">
      <h1 className="page-h1">Checkout</h1>
      <div className="checkout-layout">
        <Form method="post" className="checkout-form" replace>
          {errors.cart ? <p className="form__error">{errors.cart}</p> : null}

          <div className="field-group">
            <label htmlFor="customerName">Full name</label>
            <input id="customerName" type="text" name="customerName" defaultValue={values.customerName} required />
            {errors.customerName ? <span className="form__error">{errors.customerName}</span> : null}
          </div>
          <div className="field-group">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" name="email" defaultValue={values.email} required />
            {errors.email ? <span className="form__error">{errors.email}</span> : null}
          </div>
          <div className="field-group">
            <label htmlFor="addressLine1">Address</label>
            <input id="addressLine1" type="text" name="addressLine1" defaultValue={values.addressLine1} required />
            {errors.addressLine1 ? <span className="form__error">{errors.addressLine1}</span> : null}
          </div>
          <div className="field-group">
            <label htmlFor="addressLine2">Address line 2 (optional)</label>
            <input id="addressLine2" type="text" name="addressLine2" defaultValue={values.addressLine2} />
          </div>
          <div className="checkout-form__row">
            <div className="field-group">
              <label htmlFor="city">City</label>
              <input id="city" type="text" name="city" defaultValue={values.city} required />
              {errors.city ? <span className="form__error">{errors.city}</span> : null}
            </div>
            <div className="field-group">
              <label htmlFor="state">State/Province</label>
              <input id="state" type="text" name="state" defaultValue={values.state} required />
              {errors.state ? <span className="form__error">{errors.state}</span> : null}
            </div>
          </div>
          <div className="checkout-form__row">
            <div className="field-group">
              <label htmlFor="postalCode">Postal code</label>
              <input id="postalCode" type="text" name="postalCode" defaultValue={values.postalCode} required />
              {errors.postalCode ? <span className="form__error">{errors.postalCode}</span> : null}
            </div>
            <div className="field-group">
              <label htmlFor="country">Country</label>
              <input id="country" type="text" name="country" maxLength={2} defaultValue={values.country} required />
            </div>
          </div>
          <div className="field-group">
            <label htmlFor="notes">Order notes (optional)</label>
            <textarea id="notes" name="notes" rows={3} defaultValue={values.notes} />
          </div>

          <button type="submit" className="form-submit" disabled={submitting}>
            {submitting ? 'Placing order…' : 'Place order'}
          </button>
        </Form>

        <div className="cart-summary">
          {lines.map((line) => (
            <div key={line.id} className="summary-row">
              <span>
                {line.name} × {line.quantity}
              </span>
              <span>${(Number(line.price) * line.quantity).toFixed(2)}</span>
            </div>
          ))}
          <div className="summary-row">
            <span>Subtotal</span>
            <span>${subtotal.toFixed(2)}</span>
          </div>
          <div className="summary-row">
            <span>Shipping</span>
            <span>{shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`}</span>
          </div>
          <div className="summary-row summary-row--total">
            <span>Total</span>
            <span>${(subtotal + shipping).toFixed(2)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
