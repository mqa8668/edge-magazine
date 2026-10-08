import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getAllTagsWithCounts,
  getNavCategories,
  getPopularPosts,
  getPostsByTag,
  getRelatedTags,
  getTagBySlug,
  getTagRedirect,
  getTopTags,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { TagPageView, type TagLayout, type TagSort } from "../views/TagPage";
import { parsePage, notFound } from "./_shared";
import * as ld from "../seo/structured-data";

const PER_PAGE = 6;

// A tag page needs at least this many posts to be indexed / listed in the
// sitemap; below it the page still renders but is noindex,follow (thin content).
export const TAG_INDEX_MIN_POSTS = 2;

export async function tagRoute(c: Context<AppEnv>) {
  const slug = c.req.param("slug") ?? "";
  const d = db(c.env.DB);
  const tag = await getTagBySlug(d, slug);
  if (!tag) {
    // Merged-away tag? 301 to its canonical tag (tag-merge backfill).
    const target = await getTagRedirect(d, slug).catch(() => null);
    if (target) return c.redirect(routes.tag(target), 301);
    return notFound(c);
  }

  return withEdgeCache(c, TTL.content, async () => {
    const page = parsePage(c);
    const sort: TagSort = c.req.query("sort") === "popular" ? "popular" : "latest";
    const layout: TagLayout = c.req.query("view") === "list" ? "list" : "grid";
    const site = siteConfig(c.env, new URL(c.req.url).origin);

    const [nav, { items, total }, relatedTags, allTags, trending, popularTags] =
      await Promise.all([
        getNavCategories(d),
        getPostsByTag(d, tag.id, 1, 100),
        getRelatedTags(d, tag.id, 4),
        getAllTagsWithCounts(d),
        getPopularPosts(d, 5),
        getTopTags(d, 8),
      ]);

    let sorted = items;
    if (sort === "popular") {
      sorted = [...items].sort((a, b) => b.viewCount - a.viewCount);
    }
    const visible = sorted.slice(0, page * PER_PAGE);
    const hasMore = sorted.length > visible.length;

    const path = routes.tag(slug);
    const buildHref = (over: {
      sort?: TagSort;
      layout?: TagLayout;
      page?: number;
    }) => {
      const params = new URLSearchParams();
      const s = over.sort ?? sort;
      const v = over.layout ?? layout;
      const p = over.page ?? 1;
      if (s !== "latest") params.set("sort", s);
      if (v !== "grid") params.set("view", v);
      if (p > 1) params.set("page", String(p));
      const str = params.toString();
      return str ? `${path}?${str}` : path;
    };
    const hrefs = {
      sort: {
        latest: buildHref({ sort: "latest" }),
        popular: buildHref({ sort: "popular" }),
      },
      layout: {
        grid: buildHref({ layout: "grid" }),
        list: buildHref({ layout: "list" }),
      },
      more: buildHref({ page: page + 1 }),
    };

    const canonical = `${site.url}${path}${page > 1 ? `?page=${page}` : ""}`;
    const title = `${tag.name} articles`;
    const description =
      tag.description ||
      `${total} ${total === 1 ? "article" : "articles"} tagged ${tag.name}.`;

    const breadcrumb = [
      { name: "Home", url: site.url },
      { name: tag.name, url: `${site.url}${path}` },
    ];

    const meta = {
      title: pageTitle(site, title),
      description,
      canonical,
      // Thin tag pages (fewer than TAG_INDEX_MIN_POSTS posts) stay reachable
      // for readers but are not worth crawl budget.
      noindex: total < TAG_INDEX_MIN_POSTS,
      ogType: "website" as const,
      nextUrl: hasMore ? `${site.url}${path}?page=${page + 1}` : undefined,
      prevUrl:
        page > 1
          ? `${site.url}${path}${page - 1 > 1 ? `?page=${page - 1}` : ""}`
          : undefined,
      jsonLd: [
        ld.breadcrumb(breadcrumb),
        ld.collectionPage({
          name: title,
          description,
          url: `${site.url}${path}`,
          // ItemList capped at 10 for tag pages (tech-spec §12).
          items: items.slice(0, 10).map((p) => ({
            url: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
            name: p.title,
          })),
        }),
      ],
    };

    // Tag cloud: established tags (>= TAG_INDEX_MIN_POSTS posts) render up
    // front; one-post tags collapse behind "Xem them" so the cloud stays
    // scannable as the pipeline grows. The current tag is always up front.
    const cloudTags = allTags.filter(
      (t) => t.usageCount >= TAG_INDEX_MIN_POSTS || t.slug === tag.slug,
    );
    const moreTags = allTags.filter(
      (t) => t.usageCount < TAG_INDEX_MIN_POSTS && t.slug !== tag.slug,
    );

    const body = (
      <TagPageView
        tag={tag}
        articles={visible}
        total={total}
        hasMore={hasMore}
        hrefs={hrefs}
        sort={sort}
        layout={layout}
        relatedTags={relatedTags}
        cloudTags={cloudTags}
        moreTags={moreTags}
        trending={trending}
        popularTags={popularTags}
      />
    );

    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
