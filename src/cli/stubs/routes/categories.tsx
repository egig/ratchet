import { Link, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

interface CategoryRow {
  slug: string;
  name: string;
  description: string | null;
  imageLabel: string | null;
}

export async function loader({ context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const rows = await db.execute(
    sql`select slug, name, description, image_label as "imageLabel" from categories
        where status = 'visible' and deleted_at is null
        order by sort_order asc, name asc`,
  );
  return { categories: rows as unknown as CategoryRow[] };
}

export const meta = () => [{ title: 'Categories' }];

export default function Categories() {
  const { categories } = useLoaderData<typeof loader>();

  return (
    <section className="page-section">
      <h1 className="page-h1">Shop by category</h1>
      <p className="page-intro">Browse everything we carry, grouped into a few collections.</p>

      {categories.length === 0 ? (
        <p className="muted">No categories yet — add one in the console (Categories) to see it here.</p>
      ) : (
        <div className="grid-2">
          {categories.map((category) => (
            <div key={category.slug} className="category-card">
              <div className="swatch swatch--wide">{category.imageLabel || category.name}</div>
              <h3>{category.name}</h3>
              <p className="category-card__body">{category.description ?? ''}</p>
              <Link to={`/shop?category=${encodeURIComponent(category.slug)}`} className="link-btn category-card__link">
                Shop {category.name} →
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
