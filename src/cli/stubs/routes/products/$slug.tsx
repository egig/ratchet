import { data, Form, Link, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  sku: string;
  price: string;
  compareAtPrice: string | null;
  stock: number;
  imageLabel: string | null;
  categorySlug: string | null;
  categoryName: string | null;
}

export async function loader({ params, context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const rows = await db.execute(
    sql`select p.id, p.name, p.description, p.sku, p.price, p.compare_at_price as "compareAtPrice",
               p.stock, p.image_label as "imageLabel", c.slug as "categorySlug", c.name as "categoryName"
        from products p
        left join categories c on c.id = p.category_id and c.deleted_at is null
        where p.slug = ${params.slug} and p.status = 'active' and p.deleted_at is null limit 1`,
  );
  const product = (rows as unknown as ProductDetail[])[0];
  if (!product) throw data('Not found', { status: 404 });
  return { product };
}

export const meta = ({ data: d }: { data: Awaited<ReturnType<typeof loader>> | undefined }) => [{ title: d?.product.name ?? 'Not found' }];

export default function ProductDetail() {
  const { product } = useLoaderData<typeof loader>();
  const outOfStock = product.stock <= 0;

  return (
    <section className="page-section">
      <div className="product-detail">
        <div className="product-detail__image swatch swatch--wide">{product.imageLabel || product.name}</div>
        <div className="product-detail__info">
          {product.categoryName ? (
            <p className="muted">
              <Link to={`/shop?category=${encodeURIComponent(product.categorySlug ?? '')}`}>{product.categoryName}</Link>
            </p>
          ) : null}
          <h1 className="page-h1" style={{ marginBottom: '0.5rem' }}>
            {product.name}
          </h1>
          <p className="product-detail__sku">SKU {product.sku}</p>
          <p>
            <span className="price">${Number(product.price).toFixed(2)}</span>
            {product.compareAtPrice ? <span className="price--compare">${Number(product.compareAtPrice).toFixed(2)}</span> : null}
          </p>
          <p>{product.description ?? ''}</p>

          {outOfStock ? (
            <p className="stock-note stock-note--out">Out of stock</p>
          ) : (
            <Form method="post" action="/cart" className="add-to-cart-form">
              <input type="hidden" name="intent" value="add" />
              <input type="hidden" name="productId" value={product.id} />
              <label htmlFor="quantity" className="muted">
                Qty
              </label>
              <input id="quantity" type="number" name="quantity" defaultValue={1} min={1} max={Math.min(product.stock, 99)} className="qty-input" />
              <button type="submit" className="add-to-cart-btn">
                Add to cart
              </button>
            </Form>
          )}
        </div>
      </div>
    </section>
  );
}
