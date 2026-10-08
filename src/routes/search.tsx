import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getNavCategories,
  getPopularPosts,
  getRecentPostsForFeed,
  getTagsForPosts,
  getTopTags,
  searchPosts,
  type PostCard,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import {
  SearchPageView,
  type SearchLayout,
  type SearchSort,
} from "../views/SearchPage";
import { parsePage } from "./_shared";

const PER_PAGE = 8;

// FTS5-backed search (read side of tech-spec §11.1). Page stays noindex and
// robots.txt keeps disallowing /search?.
export async function searchRoute(c: Context<AppEnv>) {
  return withEdgeCache(c, TTL.search, async () => {
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const d = db(c.env.DB);
    const q = (c.req.query("q") ?? "").trim().slice(0, 80);
    const cat = (c.req.query("cat") ?? "all").toLowerCase();
    const sortQ = c.req.query("sort");
    const sort: SearchSort =
      sortQ === "latest" || sortQ === "popular" ? sortQ : "relevance";
    const layout: SearchLayout = c.req.query("view") === "grid" ? "grid" : "list";
    const page = parsePage(c);

    const [nav, trending, popularTags, found] = await Promise.all([
      getNavCategories(d),
      getPopularPosts(d, 5),
      getTopTags(d, 8),
      q ? searchPosts(d, q, 50) : getRecentPostsForFeed(d, 50),
    ]);

    let results: PostCard[] = found;
    if (cat !== "all") results = results.filter((p) => p.categorySlug === cat);
    if (sort === "latest") {
      results = [...results].sort((a, b) =>
        b.publishedAt.localeCompare(a.publishedAt),
      );
    } else if (sort === "popular") {
      results = [...results].sort((a, b) => b.viewCount - a.viewCount);
    }
    const visible = results.slice(0, page * PER_PAGE);
    const hasMore = results.length > visible.length;

    const relatedTags = q
      ? await getTagsForPosts(d, results.map((p) => p.id), 8)
      : [];

    // Display-state URLs: only non-defaults land in the query string.
    const buildHref = (over: {
      q?: string;
      cat?: string;
      sort?: SearchSort;
      layout?: SearchLayout;
      page?: number;
    }) => {
      const params = new URLSearchParams();
      const qq = over.q ?? q;
      const cc = over.cat ?? cat;
      const ss = over.sort ?? sort;
      const vv = over.layout ?? layout;
      const pp = over.page ?? 1;
      if (qq) params.set("q", qq);
      if (cc !== "all") params.set("cat", cc);
      if (ss !== "relevance") params.set("sort", ss);
      if (vv !== "list") params.set("view", vv);
      if (pp > 1) params.set("page", String(pp));
      const s = params.toString();
      return s ? `${routes.search()}?${s}` : routes.search();
    };

    const hrefs = {
      sort: {
        relevance: buildHref({ sort: "relevance" }),
        latest: buildHref({ sort: "latest" }),
        popular: buildHref({ sort: "popular" }),
      },
      layout: {
        list: buildHref({ layout: "list" }),
        grid: buildHref({ layout: "grid" }),
      },
      cat: [
        { slug: "all", name: "All", href: buildHref({ cat: "all" }) },
        ...nav.map((n) => ({
          slug: n.slug,
          name: n.name,
          href: buildHref({ cat: n.slug }),
        })),
      ],
      more: buildHref({ page: page + 1 }),
      suggestion: (s: string) => buildHref({ q: s, cat: "all", page: 1 }),
    };

    const meta = {
      title: pageTitle(site, q ? `Search results for "${q}"` : "Search"),
      description: q ? `Search results for "${q}".` : "Search the site.",
      canonical: `${site.url}${routes.search()}${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      ogType: "website" as const,
      noindex: true,
    };

    const body = (
      <SearchPageView
        q={q}
        results={visible}
        total={results.length}
        hasMore={hasMore}
        hrefs={hrefs}
        sort={sort}
        layout={layout}
        cat={cat}
        relatedTags={relatedTags}
        trending={trending}
        popularTags={popularTags}
      />
    );

    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
