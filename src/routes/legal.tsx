import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import { getNavCategories } from "../db/queries";
import { siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { LegalPageView } from "../views/LegalPage";
import { STATIC_PAGES } from "./pages";
import * as ld from "../seo/structured-data";

const UPDATED = "[date]";

// Render one of the legal documents (privacy / terms / cookie-policy) inside the
// shared sticky-sidebar legal layout. Content still lives in STATIC_PAGES.
export function legalPageRoute(slug: string) {
  return async (c: Context<AppEnv>) => {
    const pageDef = STATIC_PAGES[slug];
    if (!pageDef) return c.notFound();

    return withEdgeCache(c, TTL.navStatic, async () => {
      const site = siteConfig(c.env, new URL(c.req.url).origin);
      const nav = await getNavCategories(db(c.env.DB));
      const path = `/${pageDef.slug}`;
      const breadcrumb = [
        { name: "Home", url: site.url },
        { name: "Legal", url: `${site.url}/terms` },
        { name: pageDef.title, url: `${site.url}${path}` },
      ];

      const meta = {
        title: pageTitle(site, pageDef.title),
        description: pageDef.description,
        canonical: `${site.url}${path}`,
        ogType: "website" as const,
        jsonLd: [ld.breadcrumb(breadcrumb)],
      };

      const body = (
        <LegalPageView
          activeSlug={slug}
          title={pageDef.title}
          breadcrumb={breadcrumb}
          updated={UPDATED}
        >
          {pageDef.body({ name: site.name, email: site.contactEmail })}
        </LegalPageView>
      );

      return renderPage(c, { site, meta, nav, body, bare: true });
    });
  };
}
