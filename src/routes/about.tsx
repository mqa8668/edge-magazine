import type { Context } from "hono";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import { posts } from "../db/schema";
import { getAllAuthors, getNavCategories } from "../db/queries";
import { siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { AboutPageView } from "../views/AboutPage";
import * as ld from "../seo/structured-data";

export async function aboutRoute(c: Context<AppEnv>) {
  return withEdgeCache(c, TTL.navStatic, async () => {
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const d = db(c.env.DB);
    const [nav, authors, postCount] = await Promise.all([
      getNavCategories(d),
      getAllAuthors(d),
      // Real article count for the stats bar (no fabricated social proof).
      d.select({ n: sql<number>`count(*)` }).from(posts).get(),
    ]);

    const path = "/about";
    const description =
      `${site.name} is a free self-improvement magazine. Articles are drafted with AI assistance under editorial standards; author names are editorial desks, not individual people.`;
    const breadcrumb = [
      { name: "Home", url: site.url },
      { name: "About", url: `${site.url}${path}` },
    ];

    const meta = {
      title: pageTitle(site, "About"),
      description,
      canonical: `${site.url}${path}`,
      ogType: "website" as const,
      jsonLd: [ld.breadcrumb(breadcrumb), ld.organization(site)],
    };

    const body = (
      <AboutPageView
        site={site}
        contactEmail={site.contactEmail}
        authors={authors}
        postCount={postCount?.n ?? 0}
        categoryCount={nav.length}
      />
    );
    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
