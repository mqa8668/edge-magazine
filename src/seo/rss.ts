// RSS 2.0 feed (tech-spec §12): 50 latest posts, Atom self-link, per-item
// title/link/guid(permalink)/description/category/pubDate(RFC822)/author.

import type { SiteConfig } from "../lib/config";
import { routes } from "../lib/config";
import { formatRfc822 } from "../lib/dates";
import { escapeHtml } from "../lib/html";
import type { PostCard } from "../db/queries";

export function renderRss(
  site: SiteConfig,
  posts: PostCard[],
  now: Date,
): string {
  const items = posts
    .map((p) => {
      const link = `${site.url}${routes.post(p.categorySlug, p.slug)}`;
      const parts = [
        `<title>${escapeHtml(p.title)}</title>`,
        `<link>${link}</link>`,
        `<guid isPermaLink="true">${link}</guid>`,
        p.excerpt ? `<description>${escapeHtml(p.excerpt)}</description>` : "",
        `<category>${escapeHtml(p.categoryName)}</category>`,
        p.authorName ? `<author>${escapeHtml(p.authorName)}</author>` : "",
        `<pubDate>${formatRfc822(p.publishedAt)}</pubDate>`,
      ].filter(Boolean);
      return `    <item>\n      ${parts.join("\n      ")}\n    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(site.name)}</title>
    <link>${site.url}/</link>
    <description>${escapeHtml(site.tagline)}</description>
    <language>${site.language}</language>
    <lastBuildDate>${formatRfc822(now.toISOString())}</lastBuildDate>
    <atom:link href="${site.url}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}
