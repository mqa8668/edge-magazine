// One-time (re-runnable) SEO backfill for posts published before clustering +
// internal linking existed. Processes a CHUNK per call - a deployed Worker has a
// request-duration budget and each post costs 2-3 LLM calls - so the caller loops
// until `remaining` hits 0. A post is considered "done" once it has a cluster
// spoke row, which makes the whole thing idempotent (done posts are skipped).

import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { categories, posts } from "../db/schema";
import type { Bindings } from "../env";
import { getConfig } from "../lib/runtime-config";
import { cleanHtml } from "../lib/sanitize";
import { absUrl, routes, siteConfig } from "../lib/config";
import { purgeKvKeys, purgeUrls } from "../lib/cache";
import { addInternalLinks } from "./internal-links";
import { assignCluster } from "./clusters";
import { log } from "../lib/log";

const SITEMAP_KEYS = [
  "sitemap:index",
  "sitemap:posts",
  "sitemap:categories",
  "sitemap:clusters",
  "sitemap:tags",
  "sitemap:authors",
  "feed:rss",
];

export interface BackfillResult {
  processed: number;
  clustered: number;
  linked: number;
  remaining: number;
}

// Count posts not yet filed into a cluster (the backfill's work queue).
async function countRemaining(d: ReturnType<typeof db>): Promise<number> {
  const row = await d
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(sql`NOT EXISTS (SELECT 1 FROM topic_cluster_spokes s WHERE s.post_id = ${posts.id})`)
    .get();
  return row?.n ?? 0;
}

export async function backfillSeo(
  env: Bindings,
  opts: { limit?: number } = {},
): Promise<BackfillResult> {
  const cfg = await getConfig(env);
  const d = db(env.DB);
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);

  const rows = await d
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      excerpt: posts.excerpt,
      processedHtml: posts.processedHtml,
      categorySlug: categories.slug,
    })
    .from(posts)
    .innerJoin(categories, eq(categories.id, posts.categoryId))
    .where(sql`NOT EXISTS (SELECT 1 FROM topic_cluster_spokes s WHERE s.post_id = ${posts.id})`)
    .orderBy(desc(posts.publishedAt))
    .limit(limit)
    .all();

  const site = siteConfig(env);
  const changedUrls: string[] = [];
  let clustered = 0;
  let linked = 0;

  for (const p of rows) {
    // 1. Cluster assignment (this is what marks the post "done" for the queue).
    const c = await assignCluster(env, cfg, {
      postId: p.id,
      title: p.title,
      excerpt: p.excerpt,
      categorySlug: p.categorySlug,
    });
    if (c) clustered++;

    // 2. Internal links - skip if the body was already linked (idempotent).
    if (!p.processedHtml.includes('class="in-link"')) {
      const res = await addInternalLinks(env, cfg, {
        title: p.title,
        categorySlug: p.categorySlug,
        bodyHtml: p.processedHtml,
        excludeSlug: p.slug,
      });
      if (res.added > 0) {
        await d
          .update(posts)
          .set({ processedHtml: cleanHtml(res.bodyHtml), lastUpdatedAt: new Date().toISOString() })
          .where(eq(posts.id, p.id));
        linked++;
        changedUrls.push(absUrl(site, routes.post(p.categorySlug, p.slug)));
      }
    }
  }

  // Refresh caches so the new links + cluster pages + sitemaps go live.
  await purgeKvKeys(env, SITEMAP_KEYS).catch(() => {});
  if (changedUrls.length) await purgeUrls(changedUrls).catch(() => {});

  const remaining = await countRemaining(d);
  log.info("seo.backfill_chunk", { processed: rows.length, clustered, linked, remaining });
  return { processed: rows.length, clustered, linked, remaining };
}
