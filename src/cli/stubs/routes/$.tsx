import { data, useLoaderData } from 'react-router';
import { sql } from 'drizzle-orm';
import { getWebContext } from '@egig/ratchet/web';
import type { LoaderFunctionArgs } from 'react-router';

// Renders a content-managed page (a published row in the "pages" table) by its slug. Any URL that
// isn't matched by a more specific route file lands here; an unknown slug throws a 404 that the
// root ErrorBoundary renders.
interface PageRow {
  title: string;
  body: string;
  metaDescription: string | null;
}

export async function loader({ params, context }: LoaderFunctionArgs) {
  const slug = params['*'] ?? '';
  const { db, settings } = getWebContext(context);
  const [rows, site] = await Promise.all([
    db.execute(
      sql`select title, body, meta_description as "metaDescription" from pages
          where slug = ${slug} and status = 'published' and deleted_at is null limit 1`,
    ),
    settings.get('website'),
  ]);
  const page = (rows as unknown as PageRow[])[0];
  if (!page) throw data('Not found', { status: 404 });
  const siteUrl = typeof site.siteUrl === 'string' ? site.siteUrl.replace(/\/+$/, '') : '';
  return { page, canonical: siteUrl ? `${siteUrl}/${slug}` : null };
}

export const meta = ({ data: d }: { data: Awaited<ReturnType<typeof loader>> }) => {
  if (!d) return [{ title: 'Not found' }];
  return [
    { title: d.page.title },
    ...(d.page.metaDescription ? [{ name: 'description', content: d.page.metaDescription }] : []),
    ...(d.canonical ? [{ tagName: 'link' as const, rel: 'canonical', href: d.canonical }] : []),
  ];
};

export default function ContentPage() {
  const { page } = useLoaderData<typeof loader>();
  return (
    <article className="page-section prose">
      <h1>{page.title}</h1>
      {/* page.body is sanitized server-side on every write (see models/website/page.model.ts). */}
      <div dangerouslySetInnerHTML={{ __html: page.body }} />
    </article>
  );
}
