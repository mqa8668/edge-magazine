import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getNavCategories,
  getNextInCluster,
  getPopularPosts,
  getPost,
  getPostCluster,
  getPostTags,
  getRelatedPosts,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { formatIso } from "../lib/dates";
import { stripHtml, truncate } from "../lib/html";
import { uploadPath } from "../lib/images";
import { renderPage, pageTitle } from "../views/render";
import { ArticleView } from "../views/Article";
import { notFound } from "./_shared";
import * as ld from "../seo/structured-data";

// Extra per-post JSON-LD stored as-is in posts.schema_json (currently the
// FAQPage built at publish time). Returns [] on absent/invalid JSON.
function parseJsonLd(s: string | null | undefined): Record<string, unknown>[] {
  if (!s) return [];
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? [o] : [];
  } catch {
    return [];
  }
}

export async function postRoute(c: Context<AppEnv>) {
  const categorySlug = c.req.param("categorySlug") ?? "";
  const postSlug = c.req.param("postSlug") ?? "";
  const d = db(c.env.DB);
  const row = await getPost(d, categorySlug, postSlug);
  if (!row) return notFound(c);

  return withEdgeCache(c, TTL.content, async () => {
    const { post, category, author } = row;
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const [nav, tags, related, trending, cluster] = await Promise.all([
      getNavCategories(d),
      getPostTags(d, post.id),
      getRelatedPosts(d, post.id, post.categoryId),
      getPopularPosts(d, 3, post.id),
      getPostCluster(d, post.id),
    ]);
    const nextInCluster = cluster
      ? await getNextInCluster(d, cluster.id, {
          id: post.id,
          publishedAt: post.publishedAt,
        })
      : null;

    const path = routes.post(category.slug, post.slug);
    const canonical = post.canonicalUrl || `${site.url}${path}`;
    const ogImage =
      (post.ogImageKey ? uploadPath(post.ogImageKey) : null) ||
      uploadPath(post.coverImageKey);
    const ogImageAbs = ogImage ? `${site.url}${ogImage}` : undefined;
    const description =
      post.metaDescription ||
      post.excerpt ||
      truncate(stripHtml(post.processedHtml), 155);

    const breadcrumb = [
      { name: "Home", url: site.url },
      { name: category.name, url: `${site.url}${routes.category(category.slug)}` },
      { name: post.title, url: canonical },
    ];

    const meta = {
      title: pageTitle(site, post.metaTitle || post.title),
      description,
      canonical,
      ogType: "article" as const,
      ogImage: ogImageAbs,
      ogImageAlt: post.coverImageAlt || post.title,
      twitterCard: "summary_large_image" as const,
      article: {
        publishedTime: formatIso(post.publishedAt),
        modifiedTime: post.lastUpdatedAt
          ? formatIso(post.lastUpdatedAt)
          : undefined,
        author: author?.name,
        section: category.name,
      },
      jsonLd: [
        ld.article(site, {
          headline: post.title,
          description,
          imageUrl: ogImageAbs,
          url: canonical,
          datePublished: formatIso(post.publishedAt),
          dateModified: post.lastUpdatedAt
            ? formatIso(post.lastUpdatedAt)
            : null,
          authorName: author?.name ?? null,
          authorUrl: author
            ? `${site.url}${routes.author(author.slug)}`
            : null,
        }),
        ld.breadcrumb(breadcrumb),
        ...parseJsonLd(post.schemaJson),
      ],
    };

    const body = (
      <ArticleView
        post={post}
        category={category}
        author={author}
        tags={tags}
        related={related}
        trending={trending}
        cluster={cluster ?? null}
        nextInCluster={nextInCluster}
        canonical={canonical}
      />
    );

    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
