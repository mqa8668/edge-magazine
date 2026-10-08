import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getAllActiveCategoriesForSitemap,
  getAllAuthorsForSitemap,
  getAllClustersForSitemap,
  getAllPostsForSitemap,
  getAllTagsWithCounts,
  getRecentPostsForFeed,
} from "../db/queries";
import { siteConfig } from "../lib/config";
import { withKvCache, TTL } from "../lib/cache";
import { TAG_INDEX_MIN_POSTS } from "./tag";
import {
  sitemapAuthors,
  sitemapCategories,
  sitemapClusters,
  sitemapIndex,
  sitemapNews,
  sitemapPages,
  sitemapPosts,
  sitemapTags,
} from "../seo/sitemap";
import { renderRss } from "../seo/rss";

function xml(c: Context<AppEnv>, body: string, maxAge: number) {
  return c.body(body, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAge}`,
  });
}

export async function robotsRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = [
    "User-agent: *",
    "Disallow: /admin",
    "Disallow: /api",
    "Disallow: /search?",
    "Disallow: /*?ref=",
    "Disallow: /*?utm_*",
    "Allow: /",
    "",
    `Sitemap: ${site.url}/sitemap.xml`,
    "",
  ].join("\n");
  return c.body(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": `public, max-age=${TTL.navStatic}`,
  });
}

export async function sitemapIndexRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:index", TTL.sitemap, () =>
    sitemapIndex(site),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapPostsRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:posts", TTL.sitemap, async () =>
    sitemapPosts(site, await getAllPostsForSitemap(db(c.env.DB))),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapCategoriesRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(
    c,
    "sitemap:categories",
    TTL.sitemap,
    async () =>
      sitemapCategories(
        site,
        await getAllActiveCategoriesForSitemap(db(c.env.DB)),
      ),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapClustersRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:clusters", TTL.sitemap, async () =>
    sitemapClusters(site, await getAllClustersForSitemap(db(c.env.DB))),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapTagsRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:tags", TTL.sitemap, async () =>
    sitemapTags(
      site,
      // Mirror the tag route: pages below TAG_INDEX_MIN_POSTS are noindex, so
      // advertising them in the sitemap would only waste crawl budget.
      (await getAllTagsWithCounts(db(c.env.DB))).filter(
        (t) => t.usageCount >= TAG_INDEX_MIN_POSTS,
      ),
    ),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapAuthorsRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:authors", TTL.sitemap, async () =>
    sitemapAuthors(site, await getAllAuthorsForSitemap(db(c.env.DB))),
  );
  return xml(c, body, TTL.sitemap);
}

export async function sitemapPagesRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "sitemap:pages", TTL.sitemapPages, () =>
    sitemapPages(site),
  );
  return xml(c, body, TTL.sitemapPages);
}

export async function sitemapNewsRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  // News changes fast; keep its own short TTL and recompute the 48h window.
  const posts = await getAllPostsForSitemap(db(c.env.DB));
  const body = sitemapNews(site, posts, new Date());
  return xml(c, body, TTL.sitemapNews);
}

export async function feedRoute(c: Context<AppEnv>) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const body = await withKvCache(c, "feed:rss", TTL.feed, async () =>
    renderRss(site, await getRecentPostsForFeed(db(c.env.DB), 50), new Date()),
  );
  return c.body(body, 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": `public, max-age=${TTL.feed}`,
  });
}
