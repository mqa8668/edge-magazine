// Sliding-window rate limiter on KV (B6 primitive, pulled forward for the admin
// login in B4). Stores recent hit timestamps under rl:<scope>:<key> with a TTL
// equal to the window, so idle keys clean themselves up.
//
// KV is eventually consistent across PoPs, so this is an abuse brake, not an
// exact quota - fine for login throttling and API fairness. Swap the storage
// for the native rate-limiting binding when it is GA (see docs/backend-plan.md).

import type { Bindings } from "../env";
import { log, errStr } from "./log";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function rateLimit(
  env: Bindings,
  scope: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const kvKey = `rl:${scope}:${key}`;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  let hits: number[] = [];
  try {
    const raw = await env.CACHE_KV.get(kvKey);
    if (raw) hits = (JSON.parse(raw) as number[]).filter((t) => now - t < windowMs);
  } catch (e) {
    // Fail open: a broken limiter must not lock the admin out.
    log.warn("ratelimit.read_failed", { scope, err: errStr(e) });
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }

  if (hits.length >= limit) {
    const oldest = Math.min(...hits);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  hits.push(now);
  try {
    await env.CACHE_KV.put(kvKey, JSON.stringify(hits), {
      // KV minimum TTL is 60s.
      expirationTtl: Math.max(60, windowSeconds),
    });
  } catch (e) {
    log.warn("ratelimit.write_failed", { scope, err: errStr(e) });
  }
  return { allowed: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

// Best-effort client IP (Cloudflare sets CF-Connecting-IP at the edge).
export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}
