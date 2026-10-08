// IndexNow - instant search-engine indexing (Bing, Yandex, Seznam, and more
// share one submission endpoint; Google is trialing it). When a post publishes
// or is updated we ping the changed URLs so they are discovered in minutes
// instead of waiting for the next organic crawl - the single biggest lever on
// time-to-index for a site that publishes daily.
//
// The key is public (not a secret): it is echoed at the worker at /<key>.txt so the
// search engine can verify we own the host. Set INDEXNOW_KEY (wrangler [vars])
// to the same value. Empty key = silently disabled.
//
// All submits are BEST-EFFORT: a failure here must never break a publish. Each
// call is time-boxed and every outcome is logged for observability.

import type { Context, Next } from "hono";
import type { AppEnv } from "../env";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { categories, posts, topicClusters, topicClusterSpokes } from "../db/schema";
import type { Bindings } from "../env";
import { absUrl, routes, siteConfig } from "../lib/config";
import { log, errStr } from "../lib/log";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const SUBMIT_TIMEOUT_MS = 8_000;
const MAX_URLS_PER_REQUEST = 10_000; // IndexNow hard cap per submission

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  status?: number;
  skipped?: string; // reason when nothing was sent
}

// Submit an explicit list of absolute URLs. De-dupes, drops empties, chunks to
// the per-request cap, and swallows all errors (best-effort).
export async function submitIndexNow(
  env: Bindings,
  urls: string[],
): Promise<IndexNowResult> {
  const key = (env.INDEXNOW_KEY ?? "").trim();
  if (!key) return { ok: false, submitted: 0, skipped: "no INDEXNOW_KEY" };

  const site = siteConfig(env);
  const host = site.url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const keyLocation = `${site.url}/${key}.txt`;

  // Keep only same-host absolute URLs, de-duped.
  const unique = [...new Set(urls.filter((u) => u && u.startsWith(site.url)))];
  if (!unique.length) return { ok: false, submitted: 0, skipped: "no urls" };

  let submitted = 0;
  let lastStatus = 0;
  let allOk = true;
  for (let i = 0; i < unique.length; i += MAX_URLS_PER_REQUEST) {
    const batch = unique.slice(i, i + MAX_URLS_PER_REQUEST);
    const status = await postBatch(host, key, keyLocation, batch);
    lastStatus = status;
    // 200 OK / 202 Accepted both mean the list was received.
    if (status === 200 || status === 202) submitted += batch.length;
    else allOk = false;
  }

  if (allOk) log.info("indexnow.submit", { submitted, status: lastStatus });
  else log.warn("indexnow.submit_partial", { submitted, total: unique.length, status: lastStatus });
  return { ok: allOk, submitted, status: lastStatus };
}

async function postBatch(
  host: string,
  key: string,
  keyLocation: string,
  urlList: string[],
): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation, urlList }),
      signal: ctrl.signal,
    });
    // Drain the body so the connection can be reused / closed cleanly.
    if (!res.ok) {
      log.warn("indexnow.http", { status: res.status, body: (await res.text()).slice(0, 200) });
    }
    return res.status;
  } catch (e) {
    log.warn("indexnow.error", { err: errStr(e) });
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// The set of URLs that genuinely changed when one post is published/updated:
// the article itself plus the listing pages it now appears on (category + home).
// Author/tag pages also change but are lower value; kept out to avoid noisy pings.
export async function submitPostToIndexNow(
  env: Bindings,
  post: { categorySlug: string; slug: string },
): Promise<IndexNowResult> {
  const site = siteConfig(env);
  const urls = [
    absUrl(site, routes.post(post.categorySlug, post.slug)),
    absUrl(site, routes.category(post.categorySlug)),
    absUrl(site, routes.home()),
  ];
  return submitIndexNow(env, urls);
}

// Bulk submit: every published post URL + every category URL + home. Used to
// seed an engine that has never seen the site (the existing backlog), or to
// re-announce after a large change. Reads straight from the D1 projection.
export async function submitAllToIndexNow(env: Bindings): Promise<IndexNowResult> {
  const site = siteConfig(env);
  const d = db(env.DB);
  const [postRows, catRows, clusterRows] = await Promise.all([
    d
      .select({ slug: posts.slug, categorySlug: categories.slug })
      .from(posts)
      .innerJoin(categories, eq(categories.id, posts.categoryId))
      .all(),
    d.select({ slug: categories.slug }).from(categories).where(eq(categories.isActive, 1)).all(),
    d
      .selectDistinct({ slug: topicClusters.slug })
      .from(topicClusters)
      .innerJoin(topicClusterSpokes, eq(topicClusterSpokes.clusterId, topicClusters.id))
      .where(eq(topicClusters.isActive, 1))
      .all(),
  ]);
  const urls = [
    absUrl(site, routes.home()),
    absUrl(site, routes.clusters()),
    ...catRows.map((c) => absUrl(site, routes.category(c.slug))),
    ...clusterRows.map((c) => absUrl(site, routes.cluster(c.slug))),
    ...postRows.map((p) => absUrl(site, routes.post(p.categorySlug, p.slug))),
  ];
  return submitIndexNow(env, urls);
}

// Serves the IndexNow ownership file at /<key>.txt. Answers only when the path
// equals the configured key (non-empty); otherwise falls through to later routes.
export async function indexNowKeyRoute(c: Context<AppEnv>, next: Next) {
  const key = (c.env.INDEXNOW_KEY ?? "").trim();
  const file = c.req.param("file") ?? "";
  if (key && file === `${key}.txt`) {
    return c.text(key, 200, { "Cache-Control": "public, max-age=86400" });
  }
  return next();
}
