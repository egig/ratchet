import { Link, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

export const meta = () => [{ title: 'Home' }];

interface CategoryTeaser {
  slug: string;
  name: string;
  description: string | null;
}

// Top 4 visible categories, for the homepage teaser grid — the same "browse by category" entry
// point routes/categories.tsx shows in full. Other content on this page (hero copy, the testimonial)
// is hand-authored here (edit it freely); pages beyond the built-in Home/Categories/Shop/Contact are
// content-managed — create one in the console (Pages) and link to it, the way "About" is linked
// below despite no such page existing yet in a fresh scaffold.
export async function loader({ context }: LoaderFunctionArgs) {
  const { db } = getWebContext(context);
  const rows = await db.execute(
    sql`select slug, name, description from categories
        where status = 'visible' and deleted_at is null
        order by sort_order asc, name asc limit 4`,
  );
  return { categories: rows as unknown as CategoryTeaser[] };
}

export default function Home() {
  const { categories } = useLoaderData<typeof loader>();

  return (
    <>
      <section className="hero">
        <div className="hero__copy">
          <p className="hero__eyebrow">Welcome</p>
          <h1 className="hero__title">A short, confident headline about what you sell</h1>
          <p className="hero__lede">
            One or two sentences that say who you serve and what makes your shop worth a visit. Keep it concrete — a
            visitor should know within seconds whether they're in the right place.
          </p>
          <Link to="/shop" className="button button--primary">
            Shop now
          </Link>
        </div>
        <div className="hero__image swatch swatch--portrait">storefront photo</div>
      </section>

      <section className="section">
        <div style={{ maxWidth: '40rem' }}>
          <h2>Made by people, not a warehouse</h2>
          <p>A sentence or two about who's behind this shop and why that matters to a buyer.</p>
          <Link to="/about" className="link-btn">
            Read our story →
          </Link>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <div style={{ maxWidth: '33rem' }}>
            <h2>Shop by category</h2>
            <p>A few of the collections you'll find here.</p>
          </div>
          <Link to="/categories" className="link-btn">
            View all categories →
          </Link>
        </div>
        <div className="grid-4">
          {categories.length > 0 ? (
            categories.map((category) => (
              <div key={category.slug} className="teaser-card">
                <h3>{category.name}</h3>
                <p className="card-body">{category.description ?? 'Add a description in the console.'}</p>
              </div>
            ))
          ) : (
            <p className="muted">Add categories in the console to feature them here.</p>
          )}
        </div>
      </section>

      <section className="quote-section">
        <p className="quote">"Placeholder testimonial — swap this for a real customer quote."</p>
        <div className="muted">Customer name — Title</div>
      </section>

      <section className="final-cta">
        <h2>Ready to browse?</h2>
        <p className="final-cta__sub">Take a look at everything we've got in stock.</p>
        <Link to="/shop" className="button button--primary">
          Shop all products
        </Link>
      </section>
    </>
  );
}
