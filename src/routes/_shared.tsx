import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import { getNavCategories } from "../db/queries";
import { siteConfig } from "../lib/config";
import { renderPage, pageTitle } from "../views/render";

// Parse a positive ?page= integer, defaulting to 1.
export function parsePage(c: Context<AppEnv>): number {
  const raw = c.req.query("page");
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Styled 404 rendered through the Layout (so nav/footer stay consistent).
export async function notFound(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const nav = await getNavCategories(db(c.env.DB));
  const meta = {
    title: pageTitle(site, "Not found"),
    description: "The page you are looking for does not exist.",
    canonical: `${site.url}${new URL(c.req.url).pathname}`,
    ogType: "website" as const,
    noindex: true,
  };
  const body = (
    <section class="prose">
      <h1>Page not found</h1>
      <p>The page you are looking for does not exist or has moved.</p>
      <p>
        <a href="/">Back to home</a>
      </p>
    </section>
  );
  return renderPage(c, { site, meta, nav, body, status: 404 });
}
