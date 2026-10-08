import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getActiveCategories,
  getActiveCategoryBySlug,
  getCategoryContributors,
  getCategoryTags,
  getNavCategories,
  getPostTags,
  getPostsByCategory,
  type PostCard,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import {
  CategoryPageView,
  type CategoryLayout,
  type CategorySort,
} from "../views/CategoryPage";
import { parsePage, notFound } from "./_shared";
import * as ld from "../seo/structured-data";

// Grid page size below the featured card; "Load more" renders cumulatively.
const PER_PAGE = 6;

// Recency-weighted popularity for the "Trending" sort (views decayed by age).
function trendingScore(p: PostCard): number {
  const days = Math.max(
    0,
    (Date.now() - Date.parse(p.publishedAt)) / 86_400_000,
  );
  return p.viewCount / Math.pow(days + 2, 1.5);
}

export async function categoryRoute(c: Context<AppEnv>) {
  const slug = c.req.param("slug") ?? "";
  const d = db(c.env.DB);
  const category = await getActiveCategoryBySlug(d, slug);
  if (!category) return notFound(c);

  return withEdgeCache(c, TTL.content, async () => {
    const page = parsePage(c);
    const sortQ = c.req.query("sort");
    const sort: CategorySort =
      sortQ === "popular" || sortQ === "trending" ? sortQ : "latest";
    const layout: CategoryLayout =
      c.req.query("view") === "list" ? "list" : "grid";

    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const [nav, allCats, { items }, contributors, catTags] = await Promise.all([
      getNavCategories(d),
      getActiveCategories(d),
      getPostsByCategory(d, category.id, 1, 100),
      getCategoryContributors(d, category.id),
      getCategoryTags(d, category.id, 8),
    ]);

    // items are newest-first. Featured = newest; the rest feed the grid/list.
    const featured = items[0] ?? null;
    const featuredTags = featured ? await getPostTags(d, featured.id) : [];
    let rest = items.slice(1);
    if (sort === "popular") {
      rest = [...rest].sort((a, b) => b.viewCount - a.viewCount);
    } else if (sort === "trending") {
      rest = [...rest].sort((a, b) => trendingScore(b) - trendingScore(a));
    }
    const visible = rest.slice(0, page * PER_PAGE);
    const hasMore = rest.length > visible.length;

    const mostRead = [...items]
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 5);
    const banner = mostRead[0] ?? featured;
    const totalViews = items.reduce((sum, p) => sum + p.viewCount, 0);
    const others = allCats
      .filter((cat) => cat.id !== category.id)
      .map((cat) => ({
        slug: cat.slug,
        name: cat.name,
        tagline: cat.tagline,
        postCount: cat.postCount,
      }));

    // Display-state URLs (sort/view/page); only non-defaults hit the query
    // string so the canonical stays clean.
    const path = routes.category(slug);
    const buildHref = (over: {
      sort?: CategorySort;
      layout?: CategoryLayout;
      page?: number;
    }) => {
      const s = over.sort ?? sort;
      const v = over.layout ?? layout;
      const p = over.page ?? 1;
      const params = new URLSearchParams();
      if (s !== "latest") params.set("sort", s);
      if (v !== "grid") params.set("view", v);
      if (p > 1) params.set("page", String(p));
      const q = params.toString();
      return q ? `${path}?${q}` : path;
    };
    const hrefs = {
      base: path,
      sort: {
        latest: buildHref({ sort: "latest" }),
        popular: buildHref({ sort: "popular" }),
        trending: buildHref({ sort: "trending" }),
      },
      layout: {
        grid: buildHref({ layout: "grid" }),
        list: buildHref({ layout: "list" }),
      },
      more: buildHref({ page: page + 1 }),
    };

    const canonical = `${site.url}${path}${page > 1 ? `?page=${page}` : ""}`;
    const title = category.metaTitle || category.name;
    const description =
      category.metaDescription ||
      category.description ||
      `Articles in ${category.name}.`;

    const breadcrumb = [
      { name: "Home", url: site.url },
      { name: category.name, url: `${site.url}${path}` },
    ];

    const meta = {
      title: pageTitle(site, title),
      description,
      canonical,
      ogType: "website" as const,
      nextUrl: hasMore ? `${site.url}${path}?page=${page + 1}` : undefined,
      prevUrl:
        page > 1
          ? `${site.url}${path}${page - 1 > 1 ? `?page=${page - 1}` : ""}`
          : undefined,
      jsonLd: [
        ld.breadcrumb(breadcrumb),
        ld.collectionPage({
          name: category.name,
          description: category.description,
          url: `${site.url}${path}`,
          items: items.map((p) => ({
            url: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
            name: p.title,
          })),
        }),
      ],
    };

    const body = (
      <CategoryPageView
        category={category}
        banner={banner}
        totalViews={totalViews}
        featured={featured}
        featuredTags={featuredTags}
        articles={visible}
        totalRest={rest.length}
        hasMore={hasMore}
        hrefs={hrefs}
        sort={sort}
        layout={layout}
        contributors={contributors}
        mostRead={mostRead}
        catTags={catTags}
        others={others}
      />
    );

    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
