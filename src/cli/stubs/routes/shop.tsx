import { Form, Link, useLoaderData, useSearchParams } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price: string;
  compareAtPrice: string | null;
  stock: number;
  imageLabel: string | null;
}

interface CategoryOption {
  slug: string;
  name: string;
}

// The product grid — every "Add to cart" button is a real form posting to routes/cart.tsx (not a
// decoration). It redirects back to this same filtered view (`redirectTo`) rather than jumping to
// /cart, so browsing isn't interrupted; the header's cart count (routes/root.tsx) is what confirms
// the add. routes/products/$slug.tsx's own add-to-cart form omits `redirectTo` and does land on
// /cart, since landing there from a single product's page reads as a natural next step.
export async function loader({ request, context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const categorySlug = new URL(request.url).searchParams.get('category');

  const [categories, products] = await Promise.all([
    db.execute(sql`select slug, name from categories where status = 'visible' and deleted_at is null order by sort_order asc, name asc`),
    categorySlug
      ? db.execute(
          sql`select p.id, p.slug, p.name, p.description, p.price, p.compare_at_price as "compareAtPrice",
                     p.stock, p.image_label as "imageLabel"
              from products p
              join categories c on c.id = p.category_id
              where p.status = 'active' and p.deleted_at is null
                and c.slug = ${categorySlug} and c.status = 'visible' and c.deleted_at is null
              order by p.featured desc, p.name asc`,
        )
      : db.execute(
          sql`select id, slug, name, description, price, compare_at_price as "compareAtPrice", stock, image_label as "imageLabel"
              from products where status = 'active' and deleted_at is null
              order by featured desc, name asc`,
        ),
  ]);

  return {
    categories: categories as unknown as CategoryOption[],
    products: products as unknown as ProductRow[],
    activeCategory: categorySlug,
  };
}

export const meta = () => [{ title: 'Shop' }];

export default function Shop() {
  const { categories, products, activeCategory } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  return (
    <section className="page-section">
      <h1 className="page-h1">Shop</h1>
      <p className="page-intro">Everything currently available, ready to ship.</p>

      {categories.length > 0 ? (
        <div className="shop-filters">
          <Link to="/shop" className={!activeCategory ? 'active' : ''}>
            All
          </Link>
          {categories.map((category) => (
            <Link key={category.slug} to={`/shop?category=${encodeURIComponent(category.slug)}`} className={activeCategory === category.slug ? 'active' : ''}>
              {category.name}
            </Link>
          ))}
        </div>
      ) : null}

      {products.length === 0 ? (
        <p className="muted">
          {activeCategory ? 'No products in this category yet.' : 'No products yet — add one in the console (Products) to see it here.'}
        </p>
      ) : (
        <div className="shop-grid">
          {products.map((product) => {
            const outOfStock = product.stock <= 0;
            return (
              <div key={product.id} className="product-card">
                <Link to={`/products/${product.slug}`} className="swatch swatch--wide">
                  {product.imageLabel || product.name}
                </Link>
                <div className="product-row">
                  <h3>
                    <Link to={`/products/${product.slug}`}>{product.name}</Link>
                  </h3>
                  <div>
                    <span className="price">${Number(product.price).toFixed(2)}</span>
                    {product.compareAtPrice ? <span className="price--compare">${Number(product.compareAtPrice).toFixed(2)}</span> : null}
                  </div>
                </div>
                <p className="product-card__body">{product.description ?? ''}</p>
                {outOfStock ? (
                  <p className="stock-note stock-note--out">Out of stock</p>
                ) : (
                  <Form method="post" action="/cart" className="add-to-cart-form">
                    <input type="hidden" name="intent" value="add" />
                    <input type="hidden" name="productId" value={product.id} />
                    <input type="hidden" name="redirectTo" value={`/shop${searchParams.toString() ? `?${searchParams.toString()}` : ''}`} />
                    <button type="submit" className="add-to-cart-btn">
                      Add to cart
                    </button>
                  </Form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
