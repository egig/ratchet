import { Form, Link, redirect, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { addLine, cartCookieHeader, clearCartCookieHeader, hydrateCartLines, readCart, removeLine, setLineQuantity } from '../logic/cart.js';

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const lines = await hydrateCartLines(db, readCart(request));
  const subtotal = lines.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);
  return { lines, subtotal };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { db } = getWebContext(context);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const redirectTo = typeof form.get('redirectTo') === 'string' && form.get('redirectTo') ? String(form.get('redirectTo')) : '/cart';
  let lines = readCart(request);

  if (intent === 'add') {
    const productId = String(form.get('productId') ?? '');
    const requested = Number(form.get('quantity') ?? 1) || 1;
    const rows = await db.execute(sql`select stock from products where id = ${productId} and status = 'active' and deleted_at is null limit 1`);
    const product = (rows as unknown as { stock: number }[])[0];
    if (product) {
      const already = lines.find((l) => l.productId === productId)?.quantity ?? 0;
      const room = Math.max(product.stock - already, 0);
      if (room > 0) lines = addLine(lines, productId, Math.min(requested, room));
    }
  } else if (intent === 'update') {
    const productId = String(form.get('productId') ?? '');
    const quantity = Number(form.get('quantity') ?? 0);
    lines = setLineQuantity(lines, productId, quantity);
  } else if (intent === 'remove') {
    lines = removeLine(lines, String(form.get('productId') ?? ''));
  } else if (intent === 'clear') {
    lines = [];
  }

  return redirect(redirectTo, { headers: { 'Set-Cookie': lines.length > 0 ? cartCookieHeader(lines) : clearCartCookieHeader() } });
}

export const meta = () => [{ title: 'Cart' }];

export default function Cart() {
  const { lines, subtotal } = useLoaderData<typeof loader>();

  return (
    <section className="page-section">
      <h1 className="page-h1">Your cart</h1>

      {lines.length === 0 ? (
        <div className="empty-state">
          <p>Your cart is empty.</p>
          <Link to="/shop" className="button button--primary">
            Continue shopping
          </Link>
        </div>
      ) : (
        <div className="cart-layout">
          <div className="cart-lines">
            {lines.map((line) => (
              <div key={line.id} className="cart-line">
                <Link to={`/products/${line.slug}`} className="swatch swatch--wide cart-line__swatch">
                  {line.imageLabel || line.name}
                </Link>
                <div className="cart-line__info">
                  <p className="cart-line__name">
                    <Link to={`/products/${line.slug}`}>{line.name}</Link>
                  </p>
                  <p className="muted">${Number(line.price).toFixed(2)} each</p>
                  <div className="cart-line__actions">
                    <Form method="post">
                      <input type="hidden" name="intent" value="update" />
                      <input type="hidden" name="productId" value={line.id} />
                      <input
                        type="number"
                        name="quantity"
                        defaultValue={line.quantity}
                        min={0}
                        max={Math.max(line.stock, line.quantity)}
                        className="qty-input"
                        onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        aria-label={`Quantity for ${line.name}`}
                      />
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="productId" value={line.id} />
                      <button type="submit" className="button button--danger button--small">
                        Remove
                      </button>
                    </Form>
                  </div>
                </div>
                <div className="cart-line__total">${(Number(line.price) * line.quantity).toFixed(2)}</div>
              </div>
            ))}
          </div>

          <div className="cart-summary">
            <div className="summary-row summary-row--total">
              <span>Subtotal</span>
              <span>${subtotal.toFixed(2)}</span>
            </div>
            <p className="muted" style={{ marginBottom: '1.25rem' }}>
              Shipping and totals are calculated at checkout.
            </p>
            <Link to="/checkout" className="button button--primary" style={{ width: '100%', textAlign: 'center' }}>
              Checkout
            </Link>
            <Form method="post" style={{ marginTop: '0.75rem' }}>
              <input type="hidden" name="intent" value="clear" />
              <button type="submit" className="link-btn">
                Clear cart
              </button>
            </Form>
          </div>
        </div>
      )}
    </section>
  );
}
