import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getAllAuthors,
  getAuthorBySlug,
  getNavCategories,
  getPopularPosts,
  getPostsByAuthor,
  getTopTags,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { truncate } from "../lib/html";
import { uploadPath } from "../lib/images";
import { renderPage, pageTitle } from "../views/render";
import { formatViews } from "../views/components";
import {
  AuthorPageView,
  type AuthorSort,
  type AuthorTab,
} from "../views/AuthorPage";
import { parsePage, notFound } from "./_shared";
import * as ld from "../seo/structured-data";

const PER_PAGE = 6;

export async function authorRoute(c: Context<AppEnv>) {
  const slug = c.req.param("slug") ?? "";
  const d = db(c.env.DB);
  const author = await getAuthorBySlug(d, slug);
  if (!author) return notFound(c);

  return withEdgeCache(c, TTL.content, async () => {
    const page = parsePage(c);
    const sort: AuthorSort =
      c.req.query("sort") === "popular" ? "popular" : "latest";
    const tab: AuthorTab = c.req.query("tab") === "about" ? "about" : "articles";
    const site = siteConfig(c.env, new URL(c.req.url).origin);

    const [nav, { items, total }, allAuthors, trending, popularTags] =
      await Promise.all([
        getNavCategories(d),
        getPostsByAuthor(d, author.id, 1, 100),
        getAllAuthors(d),
        getPopularPosts(d, 5),
        getTopTags(d, 8),
      ]);

    let sorted = items;
    if (sort === "popular") {
      sorted = [...items].sort((a, b) => b.viewCount - a.viewCount);
    }
    const visible = sorted.slice(0, page * PER_PAGE);
    const hasMore = sorted.length > visible.length;

    const totalViews = formatViews(
      items.reduce((sum, p) => sum + p.viewCount, 0),
    );
    const otherAuthors = allAuthors.filter((a) => a.id !== author.id);

    const path = routes.author(slug);
    const buildHref = (over: {
      sort?: AuthorSort;
      tab?: AuthorTab;
      page?: number;
    }) => {
      const params = new URLSearchParams();
      const s = over.sort ?? sort;
      const t = over.tab ?? tab;
      const p = over.page ?? 1;
      if (t !== "articles") params.set("tab", t);
      if (s !== "latest" && t === "articles") params.set("sort", s);
      if (p > 1 && t === "articles") params.set("page", String(p));
      const str = params.toString();
      return str ? `${path}?${str}` : path;
    };
    const hrefs = {
      articles: buildHref({ tab: "articles" }),
      about: buildHref({ tab: "about" }),
      sort: {
        latest: buildHref({ sort: "latest" }),
        popular: buildHref({ sort: "popular" }),
      },
      more: buildHref({ page: page + 1 }),
    };

    const canonical = `${site.url}${path}${page > 1 ? `?page=${page}` : ""}`;
    const title = `Articles by ${author.name}`;
    const description = author.shortBio
      ? truncate(author.shortBio, 155)
      : author.bio
        ? truncate(author.bio, 155)
        : `Articles by ${author.name}.`;
    const avatar = author.avatarKey ? uploadPath(author.avatarKey) : null;
    const avatarAbs = avatar ? `${site.url}${avatar}` : undefined;

    const breadcrumb = [
      { name: "Home", url: site.url },
      { name: author.name, url: `${site.url}${path}` },
    ];

    const meta = {
      title: pageTitle(site, title),
      description,
      canonical,
      ogType: "website" as const,
      // Author avatars are SVGs, which social platforms will not render as an
      // og:image. Fall back to the branded PNG default instead of shipping a
      // broken SVG card. (The avatar still feeds the ProfilePage JSON-LD below.)
      nextUrl: hasMore ? `${site.url}${path}?page=${page + 1}` : undefined,
      prevUrl:
        page > 1
          ? `${site.url}${path}${page - 1 > 1 ? `?page=${page - 1}` : ""}`
          : undefined,
      jsonLd: [
        ld.breadcrumb(breadcrumb),
        ld.personPage({
          name: author.name,
          description: author.bio,
          url: `${site.url}${path}`,
          imageUrl: avatarAbs,
          items: items.map((p) => ({
            url: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
            name: p.title,
          })),
        }),
      ],
    };

    const body = (
      <AuthorPageView
        author={author}
        totalViews={totalViews}
        articles={visible}
        total={total}
        hasMore={hasMore}
        hrefs={hrefs}
        sort={sort}
        tab={tab}
        otherAuthors={otherAuthors}
        trending={trending}
        popularTags={popularTags}
      />
    );

    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
