// Google Search Console demand source (read-only analytics). GSC knows what
// people ALREADY search to reach this site - proven demand. This pulls the queries the site gets impressions for, routes
// each to the category of its ranking page, and hands them to topic ideation
// (see generate.ts) so new articles target
// near-ranking, real-demand queries.
//
// Auth is a service-account JWT (WebCrypto RS256) exchanged for an OAuth token
// (KV-cached ~55m). Everything is best-effort and cache-first: no key, the
// feature off, an auth/API error, or (for now) an empty property all yield an
// empty map, and ideation proceeds without the signal. It must
// never break a run. Harmless while GSC is still accumulating data - it simply
// contributes nothing until the property has queries, then self-activates.

import type { Bindings } from "../env";
import type { RuntimeConfig } from "../lib/runtime-config";
import { cleanText } from "../lib/sanitize";
import { foldAscii } from "../lib/slug";
import { hasHardHit } from "./safety";
import { log, errStr } from "../lib/log";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE_WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_KV_PREFIX = "gsc:token:"; // per-scope token cache
const DEMAND_KV_KEY = "gsc:demand:v1";

interface SaKey {
  client_email: string;
  private_key: string;
}

export interface GscRow {
  query: string;
  page: string;
  impressions: number;
  position: number;
  clicks: number;
}

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

// Article URLs are /:categorySlug/:postSlug. Return the category slug when the
// ranking page is an article in a known category, else null (home, /tags,
// /authors, /clusters, static pages - not routable to a content category).
export function pageToCategory(
  pageUrl: string,
  validSlugs: Set<string>,
): string | null {
  try {
    const segs = new URL(pageUrl).pathname.split("/").filter(Boolean);
    return segs.length >= 2 && validSlugs.has(segs[0]) ? segs[0] : null;
  } catch {
    return null;
  }
}

// Merge two keyword lists, primary first (higher priority), dedup on the
// diacritic-folded form, cap at max.
export function mergeDemand(
  primary: string[],
  secondary: string[],
  max: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of [...primary, ...secondary]) {
    const k = foldAscii(q).trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

// ── JWT / OAuth (WebCrypto, runs in the Worker) ──────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signJwt(sa: SaKey, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${b64urlJson({ alg: "RS256", typ: "JWT" })}.` +
    b64urlJson({
      iss: sa.client_email,
      scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    });
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// Exchange a signed JWT for an access token (no KV; used by the cached wrapper
// and the local verification harness).
export async function exchangeToken(jwt: string): Promise<string | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) {
    log.warn("gsc.token_failed", { body: JSON.stringify(j).slice(0, 200) });
    return null;
  }
  return j.access_token;
}

async function getAccessToken(
  env: Bindings,
  sa: SaKey,
  scope: string,
): Promise<string | null> {
  const cacheKey = TOKEN_KV_PREFIX + (scope.split("/").pop() ?? "default");
  try {
    const cached = await env.CACHE_KV.get(cacheKey);
    if (cached) return cached;
  } catch {
    /* fall through to mint */
  }
  const token = await exchangeToken(await signJwt(sa, scope));
  if (token) {
    try {
      await env.CACHE_KV.put(cacheKey, token, { expirationTtl: 3300 });
    } catch (e) {
      log.warn("gsc.token_cache_failed", { err: errStr(e) });
    }
  }
  return token;
}

// ── Search Analytics query ───────────────────────────────────────────────────

export async function queryAnalytics(
  token: string,
  property: string,
  body: Record<string, unknown>,
): Promise<GscRow[]> {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      property,
    )}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    log.warn("gsc.query_failed", { status: res.status });
    return [];
  }
  const j = (await res.json()) as {
    rows?: { keys: string[]; impressions: number; position: number; clicks: number }[];
  };
  return (j.rows ?? []).map((r) => ({
    query: r.keys[0] ?? "",
    page: r.keys[1] ?? "",
    impressions: r.impressions,
    position: r.position,
    clicks: r.clicks,
  }));
}

const isoDate = (msFromNow: number) =>
  new Date(Date.now() - msFromNow).toISOString().slice(0, 10);

// Proven-demand queries grouped by the category of their ranking page. Cached in
// KV for cfg.seo.gsc.cacheDays. Returns an empty map when disabled / no key /
// auth or API failure / no data.
export async function getGscDemandByCategory(
  env: Bindings,
  cfg: RuntimeConfig,
  validSlugs: Set<string>,
): Promise<Map<string, string[]>> {
  const gc = cfg.seo.gsc;
  const empty = new Map<string, string[]>();
  if (!gc?.enabled || !env.GSC_SA_KEY) return empty;

  try {
    const cached = await env.CACHE_KV.get(DEMAND_KV_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { byCat: Record<string, string[]> };
      return new Map(Object.entries(parsed.byCat ?? {}));
    }
  } catch (e) {
    log.warn("gsc.cache_read_failed", { err: errStr(e) });
  }

  let sa: SaKey;
  try {
    sa = JSON.parse(env.GSC_SA_KEY) as SaKey;
  } catch {
    log.warn("gsc.bad_key");
    return empty;
  }

  const token = await getAccessToken(env, sa, SCOPE_WEBMASTERS).catch((e) => {
    log.warn("gsc.token_error", { err: errStr(e) });
    return null;
  });
  if (!token) return empty;

  const rows = await queryAnalytics(token, gc.siteUrl, {
    startDate: isoDate(gc.lookbackDays * 86_400_000),
    endDate: isoDate(2 * 86_400_000), // GSC data lags ~2 days
    dimensions: ["query", "page"],
    rowLimit: gc.rowLimit,
  }).catch((e) => {
    log.warn("gsc.query_error", { err: errStr(e) });
    return [] as GscRow[];
  });

  // Route + filter: keep queries with real impressions where the site ranks at
  // positionMin or worse (room to grow; already-won queries are excluded so we
  // do not spawn a cannibalizing second article for a query we already own).
  const byCat = new Map<string, { q: string; imp: number }[]>();
  for (const r of rows) {
    if (r.impressions < gc.minImpressions || r.position < gc.positionMin) continue;
    const slug = pageToCategory(r.page, validSlugs);
    if (!slug) continue;
    const q = cleanText(r.query).trim();
    if (!q || hasHardHit(q, cfg.safety)) continue;
    const list = byCat.get(slug) ?? [];
    list.push({ q, imp: r.impressions });
    byCat.set(slug, list);
  }

  const out = new Map<string, string[]>();
  for (const [slug, arr] of byCat) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const { q } of arr.sort((a, b) => b.imp - a.imp)) {
      const k = foldAscii(q);
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(q);
      if (list.length >= gc.maxPerCategory) break;
    }
    out.set(slug, list);
  }

  try {
    await env.CACHE_KV.put(
      DEMAND_KV_KEY,
      JSON.stringify({ at: Date.now(), byCat: Object.fromEntries(out) }),
      { expirationTtl: Math.max(3600, gc.cacheDays * 86_400) },
    );
  } catch (e) {
    log.warn("gsc.cache_write_failed", { err: errStr(e) });
  }
  log.info("gsc.demand_built", { rows: rows.length, cats: out.size });
  return out;
}
