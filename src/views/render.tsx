import { html } from "hono/html";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import type { SiteConfig } from "../lib/config";
import { db } from "../db/client";
import { getBreakingPost } from "../db/queries";
import { Layout, type NavCategory } from "./Layout";
import type { PageMeta } from "./Head";

// Render a full HTML document (with doctype) for a route.
export async function renderPage(
  c: Context<AppEnv>,
  opts: {
    site: SiteConfig;
    meta: PageMeta;
    nav: NavCategory[];
    body: unknown;
    status?: number;
    // bare: the page manages its own full-bleed sections/containers
    // (article detail); default wraps children in .container.
    bare?: boolean;
  },
) {
  const currentPath = new URL(c.req.url).pathname;
  // Latest published article for the top-bar ticker. Best-effort: a DB hiccup
  // must never fail a page render (the ticker just hides). Cached into the page
  // HTML, so it refreshes when publishPost purges caches - same as everything else.
  const breaking = await getBreakingPost(db(c.env.DB)).catch(() => null);
  const doc = html`<!doctype html>${(
    <Layout
      site={opts.site}
      meta={opts.meta}
      nav={opts.nav}
      currentPath={currentPath}
      bare={opts.bare}
      breaking={breaking}
    >
      {opts.body as never}
    </Layout>
  )}`;
  return c.html(doc, (opts.status ?? 200) as 200);
}

// Title with site-name suffix (home passes home=true to skip the suffix and use
// the brand + tagline form instead).
export function pageTitle(
  site: SiteConfig,
  title: string,
  home = false,
): string {
  if (home) return `${site.name} - ${site.tagline}`;
  return title ? `${title} | ${site.name}` : site.name;
}
