import { useState } from 'react';
import { Link, NavLink, Outlet, isRouteErrorResponse, useLoaderData, useRouteError } from 'react-router';
import { Meta, Scripts, getWebContext } from '@egig/ratchet/web';
import { sql } from 'drizzle-orm';
import type { LoaderFunctionArgs } from 'react-router';
import { readCart, cartItemCount } from '../logic/cart.js';

// The root route renders the whole HTML document. Its loader reads the console-editable "website"
// Domain Settings (site title, description, favicon, siteUrl, noindex), the published pages that
// opted into the header/footer nav (Pages → Navigation in the console), and the visitor's cart
// count (logic/cart.ts) for the header's cart link.
interface NavPage {
  slug: string;
  title: string;
  navLocation: 'header' | 'footer';
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { db, settings } = getWebContext(context);
  const [site, navRows] = await Promise.all([
    settings.get('website'),
    db.execute(
      sql`select slug, title, nav_location as "navLocation" from pages
          where status = 'published' and nav_location in ('header', 'footer') and deleted_at is null
          order by nav_order asc, title asc`,
    ),
  ]);
  return { site, nav: navRows as unknown as NavPage[], cartCount: cartItemCount(readCart(request)) };
}

export const meta = ({ data }: { data: Awaited<ReturnType<typeof loader>> }) => {
  const site = data?.site ?? {};
  const title = typeof site.title === 'string' && site.title ? site.title : 'My store';
  const description = typeof site.description === 'string' ? site.description : '';
  const faviconUrl =
    site.favicon && typeof site.favicon === 'object' && 'url' in site.favicon ? String((site.favicon as { url: unknown }).url) : '';
  return [
    { title },
    ...(description ? [{ name: 'description', content: description }] : []),
    ...(site.noindex ? [{ name: 'robots', content: 'noindex, nofollow' }] : []),
    ...(faviconUrl ? [{ tagName: 'link' as const, rel: 'icon', href: faviconUrl }] : []),
  ];
};

function SiteHead() {
  return (
    <>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Inter:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      <link rel="stylesheet" href="/theme.css" />
    </>
  );
}

export default function Root() {
  const { site, nav, cartCount } = useLoaderData<typeof loader>();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const siteName = typeof site.title === 'string' && site.title ? site.title : 'My store';
  const header = nav.filter((p) => p.navLocation === 'header');
  const footer = nav.filter((p) => p.navLocation === 'footer');
  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <html lang="en">
      <head>
        <SiteHead />
        <Meta />
      </head>
      <body>
        <header className="site-header">
          <Link to="/" className="site-header__brand">
            {siteName}
          </Link>
          <nav className="site-nav">
            {header.map((p) => (
              <NavLink key={p.slug} to={`/${p.slug}`} className="site-nav__link">
                {p.title}
              </NavLink>
            ))}
            <NavLink to="/categories" className="site-nav__link">
              Categories
            </NavLink>
            <NavLink to="/shop" className="site-nav__link">
              Shop
            </NavLink>
            <NavLink to="/contact" className="site-nav__link">
              Contact
            </NavLink>
          </nav>
          <div className="site-header__actions">
            <Link to="/cart" className="site-header__cart">
              Cart{cartCount > 0 ? ` (${cartCount})` : ''}
            </Link>
            <Link to="/contact" className="site-header__cta">
              Get in touch
            </Link>
            <button
              type="button"
              className="hamburger"
              onClick={() => setMobileMenuOpen((open) => !open)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileMenuOpen ? 'Close' : 'Menu'}
            </button>
          </div>
        </header>

        {mobileMenuOpen ? (
          <div className="mobile-menu">
            {header.map((p) => (
              <Link key={p.slug} to={`/${p.slug}`} className="mobile-menu__item" onClick={closeMenu}>
                {p.title}
              </Link>
            ))}
            <Link to="/categories" className="mobile-menu__item" onClick={closeMenu}>
              Categories
            </Link>
            <Link to="/shop" className="mobile-menu__item" onClick={closeMenu}>
              Shop
            </Link>
            <Link to="/contact" className="mobile-menu__item" onClick={closeMenu}>
              Contact
            </Link>
            <Link to="/cart" className="mobile-menu__item" onClick={closeMenu}>
              Cart{cartCount > 0 ? ` (${cartCount})` : ''}
            </Link>
          </div>
        ) : null}

        <main className="site-main">
          <Outlet />
        </main>

        <footer className="site-footer">
          <div className="site-footer__inner">
            <div>
              <div className="site-footer__name">{siteName}</div>
              <div className="muted">{typeof site.description === 'string' ? site.description : ''}</div>
            </div>
            <div className="muted">© {new Date().getFullYear()} {siteName}</div>
            <nav className="site-footer__nav">
              {footer.map((p) => (
                <Link key={p.slug} to={`/${p.slug}`}>
                  {p.title}
                </Link>
              ))}
              <Link to="/shop">Shop</Link>
              <Link to="/contact">Contact</Link>
            </nav>
          </div>
        </footer>

        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const heading = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Something went wrong';
  return (
    <html lang="en">
      <head>
        <SiteHead />
        <title>{heading}</title>
      </head>
      <body>
        <main className="site-main">
          <div className="page-section prose">
            <h1>{is404 ? 'Page not found' : heading}</h1>
            <p>{is404 ? "That page doesn't exist." : 'Please try again in a moment.'}</p>
            <p>
              <a href="/">Back to home</a>
            </p>
          </div>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
