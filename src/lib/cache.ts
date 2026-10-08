import type { Context } from "hono";
import type { AppEnv, Bindings } from "../env";

// Two-layer caching (tech-spec §9):
//  1. Cache API (per-PoP) — full rendered Response keyed by URL.
//  2. KV (global) — pre-rendered, render-independent payloads (sitemaps, RSS).
// Invalidation is explicit purge on publish (Phase 2); here we just populate.

// TTLs mirror today's Cachex values (§9).
export const TTL = {
  content: 3600, // 1h — home, article, category, tag, author
  navStatic: 86400, // 24h — static pages
  sitemap: 21600, // 6h
  sitemapNews: 1800, // 30m
  sitemapPages: 86400, // 24h
  search: 300, // 5m
  feed: 3600, // 1h
} as const;

type Ctx = Context<AppEnv>;

// Bump to invalidate the ENTIRE Cache API at once (per-PoP has no global purge,
// so a deploy that changes shared chrome - e.g. the footer disclosure - would
// otherwise serve stale HTML until each key's TTL expires, up to 24h for static
// pages). Bumping the version orphans every old key: the next request per URL is
// a guaranteed MISS that re-renders and re-caches. Old entries age out by TTL.
const CACHE_VERSION = "12";

// The Cache API key for a page URL, namespaced by CACHE_VERSION.
function pageCacheKey(url: string): Request {
  const u = new URL(url);
  u.searchParams.set("__v", CACHE_VERSION);
  return new Request(u.toString(), { method: "GET" });
}

// Wrap a GET render in the per-PoP Cache API. Returns the cached Response on a
// hit; otherwise renders, stores a clone with the given max-age, and returns it.
export async function withEdgeCache(
  c: Ctx,
  ttlSeconds: number,
  render: () => Promise<Response> | Response,
): Promise<Response> {
  if (c.req.method !== "GET") return render();

  const cache = caches.default;
  const cacheKey = pageCacheKey(c.req.url);

  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set("CF-Cache-Status", "HIT");
    return res;
  }

  const rendered = await render();
  const stored = new Response(rendered.body, rendered);
  stored.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  stored.headers.set("CF-Cache-Status", "MISS");

  // Only cache successful responses.
  if (stored.status === 200) {
    c.executionCtx.waitUntil(cache.put(cacheKey, stored.clone()));
  }
  return stored;
}

// KV: read a pre-rendered payload, else build, store with TTL, and return it.
export async function withKvCache(
  c: Ctx,
  key: string,
  ttlSeconds: number,
  build: () => Promise<string> | string,
): Promise<string> {
  const cached = await c.env.CACHE_KV.get(key);
  if (cached !== null) return cached;

  const body = await build();
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(key, body, { expirationTtl: ttlSeconds }),
  );
  return body;
}

// ── Explicit invalidation on publish (tech-spec §9) ─────────────────────────
// Cache API is per-PoP: delete only evicts the current PoP's copy; the TTL bounds
// staleness on every other PoP. KV is global, so KV deletes are authoritative.

// Purge a set of absolute page URLs from the per-PoP Cache API.
export async function purgeUrls(urls: string[]): Promise<void> {
  const cache = caches.default;
  await Promise.allSettled(urls.map((u) => cache.delete(pageCacheKey(u))));
}

// Delete a set of pre-rendered payloads (sitemaps, feed) from the global KV cache.
export async function purgeKvKeys(env: Bindings, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((k) => env.CACHE_KV.delete(k)));
}
