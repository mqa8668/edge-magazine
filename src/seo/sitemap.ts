// Sitemap XML builders (tech-spec §12). Phase 1 emits: index + posts +
// categories + pages + news. Clusters land with the cluster routes in Phase 3.

import type { SiteConfig } from "../lib/config";
import { routes } from "../lib/config";
import { formatIso, formatIsoDate, hoursSince } from "../lib/dates";
import { escapeHtml } from "../lib/html";
import type { SitemapPost } from "../db/queries";

const URLSET_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const URLSET_CLOSE = "</urlset>";

interface UrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

function urlEntry(e: UrlEntry): string {
  const parts = [`<loc>${escapeHtml(e.loc)}</loc>`];
  if (e.lastmod) parts.push(`<lastmod>${e.lastmod}</lastmod>`);
  if (e.changefreq) parts.push(`<changefreq>${e.changefreq}</changefreq>`);
  if (e.priority) parts.push(`<priority>${e.priority}</priority>`);
  return `  <url>\n    ${parts.join("\n    ")}\n  </url>`;
}

// Sub-sitemap names referenced by the index and the route table.
export const SUB_SITEMAPS = [
  "posts",
  "categories",
  "clusters",
  "tags",
  "authors",
  "pages",
  "news",
] as const;

export function sitemapIndex(site: SiteConfig): string {
  const entries = SUB_SITEMAPS.map(
    (name) =>
      `  <sitemap>\n    <loc>${site.url}/sitemap-${name}.xml</loc>\n  </sitemap>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>`;
}

export function sitemapPosts(site: SiteConfig, posts: SitemapPost[]): string {
  const urls = posts
    .map((p) =>
      urlEntry({
        loc: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
        lastmod: formatIsoDate(p.lastUpdatedAt || p.publishedAt),
        changefreq: "weekly",
        priority: "0.8",
      }),
    )
    .join("\n");
  return `${URLSET_OPEN}\n${urls}\n${URLSET_CLOSE}`;
}

export function sitemapCategories(
  site: SiteConfig,
  categories: { slug: string }[],
): string {
  const urls = categories
    .map((cat) =>
      urlEntry({
        loc: `${site.url}${routes.category(cat.slug)}`,
        changefreq: "daily",
        priority: "0.9",
      }),
    )
    .join("\n");
  return `${URLSET_OPEN}\n${urls}\n${URLSET_CLOSE}`;
}

// Tag archive pages (indexable, index,follow). Callers pass only tags with at
// least TAG_INDEX_MIN_POSTS posts - thinner archives are noindex on the route.
export function sitemapTags(site: SiteConfig, tags: { slug: string }[]): string {
  const urls = tags
    .map((t) =>
      urlEntry({
        loc: `${site.url}${routes.tag(t.slug)}`,
        changefreq: "weekly",
        priority: "0.4",
      }),
    )
    .join("\n");
  return `${URLSET_OPEN}\n${urls}\n${URLSET_CLOSE}`;
}

// Author archive pages (pen-name bylines).
export function sitemapAuthors(
  site: SiteConfig,
  authors: { slug: string }[],
): string {
  const urls = authors
    .map((a) =>
      urlEntry({
        loc: `${site.url}${routes.author(a.slug)}`,
        changefreq: "weekly",
        priority: "0.5",
      }),
    )
    .join("\n");
  return `${URLSET_OPEN}\n${urls}\n${URLSET_CLOSE}`;
}

// Topic-cluster pillar pages (SEO phase 2b): the /clusters index + each hub.
export function sitemapClusters(
  site: SiteConfig,
  clusters: { slug: string; updatedAt?: string | null }[],
): string {
  const index = urlEntry({
    loc: `${site.url}${routes.clusters()}`,
    changefreq: "daily",
    priority: "0.7",
  });
  const hubs = clusters
    .map((cl) =>
      urlEntry({
        loc: `${site.url}${routes.cluster(cl.slug)}`,
        lastmod: cl.updatedAt ? formatIsoDate(cl.updatedAt) : undefined,
        changefreq: "weekly",
        priority: "0.7",
      }),
    )
    .join("\n");
  return `${URLSET_OPEN}\n${index}${hubs ? "\n" + hubs : ""}\n${URLSET_CLOSE}`;
}

const STATIC_PAGE_PRIORITIES: { slug: string; priority: string }[] = [
  { slug: "about", priority: "0.5" },
  { slug: "editorial-standards", priority: "0.4" },
  { slug: "contact", priority: "0.4" },
  { slug: "privacy", priority: "0.3" },
  { slug: "terms", priority: "0.3" },
  { slug: "dmca", priority: "0.3" },
];

export function sitemapPages(site: SiteConfig): string {
  const home = urlEntry({
    loc: `${site.url}/`,
    changefreq: "daily",
    priority: "1.0",
  });
  const pages = STATIC_PAGE_PRIORITIES.map((p) =>
    urlEntry({
      loc: `${site.url}/${p.slug}`,
      changefreq: "yearly",
      priority: p.priority,
    }),
  ).join("\n");
  return `${URLSET_OPEN}\n${home}\n${pages}\n${URLSET_CLOSE}`;
}

// Google News sitemap — posts published in the last 48h.
export function sitemapNews(
  site: SiteConfig,
  posts: SitemapPost[],
  now: Date,
): string {
  const recent = posts.filter((p) => hoursSince(p.publishedAt, now) <= 48);
  const urls = recent
    .map((p) => {
      return `  <url>\n    <loc>${site.url}${routes.post(
        p.categorySlug,
        p.slug,
      )}</loc>\n    <news:news>\n      <news:publication>\n        <news:name>${escapeHtml(
        site.name,
      )}</news:name>\n        <news:language>vi</news:language>\n      </news:publication>\n      <news:publication_date>${formatIso(
        p.publishedAt,
      )}</news:publication_date>\n      <news:title>${escapeHtml(
        p.title,
      )}</news:title>\n    </news:news>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${urls}\n</urlset>`;
}
