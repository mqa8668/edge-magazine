// Publish API - the authenticated HTTP surface over publishPost(). Mounted at
// /api in src/index.ts. Auth is a bearer token equal to the PUBLISH_TOKEN secret
// (set via `wrangler secret put PUBLISH_TOKEN`). The Cron orchestrator (Phase 2)
// bypasses HTTP and calls publishPost() directly on the edge.

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { PublishError, publishPost, reindexFts } from "./publish";
import type { PublishInput } from "./types";
import { beginQueueItemRun, runBatch } from "../pipeline/generate";
import { popPending } from "../pipeline/queue";
import { reclaimRun } from "../pipeline/telemetry";
import { submitAllToIndexNow } from "../seo/indexnow";
import { backfillSeo } from "../pipeline/seo-backfill";
import { log, errStr } from "../lib/log";
import { getConfig } from "../lib/runtime-config";
import { healthReport } from "../pipeline/telemetry";
import { clientIp, rateLimit } from "../lib/ratelimit";

export const api = new Hono<AppEnv>();

// Per-IP fairness cap over the whole API (backstop against a runaway caller /
// leaked token loop). Generous - real use is a handful of calls per run.
const API_RATE_LIMIT = 60;
const API_RATE_WINDOW_S = 60;

// Bearer-token gate + rate limit shared by every route. Returns an error
// Response when not authorized / over the cap, or null to proceed.
async function authError(c: Context<AppEnv>) {
  const secret = c.env.PUBLISH_TOKEN;
  if (!secret) return c.json({ ok: false, error: "publishing not configured" }, 503);
  const presented = (c.req.header("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!timingSafeEqual(presented, secret)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const ip = clientIp(c.req.raw);
  const rl = await rateLimit(c.env, "api", ip, API_RATE_LIMIT, API_RATE_WINDOW_S);
  if (!rl.allowed) {
    c.header("Retry-After", String(rl.retryAfterSeconds));
    return c.json(
      { ok: false, error: "rate limited", retryAfter: rl.retryAfterSeconds },
      429,
    );
  }
  return null;
}

api.post("/publish", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;

  let input: PublishInput;
  try {
    input = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }

  try {
    const result = await publishPost(c.env, input);
    return c.json(result, result.created ? 201 : 200);
  } catch (err) {
    if (err instanceof PublishError) {
      return c.json({ ok: false, error: err.message }, err.status as 400);
    }
    log.error("publish.failed", { err: errStr(err) });
    return c.json({ ok: false, error: "internal error" }, 500);
  }
});

// Manually trigger a content-generation batch (the Cron uses runBatch directly).
// Used for the backfill. NOTE: a deployed Worker has a request-duration budget, so
// on staging/prod keep count small and chunk large backfills across calls; local
// wrangler dev has no such limit, so the full backfill can run in one call.
//
// Honors the pipeline.enabled kill switch (config KV); pass ?force=1 to override
// (e.g. a deliberate backfill while the daily cron is paused).
api.post("/run", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  const count = Math.min(Math.max(Number(c.req.query("count") ?? "2") || 2, 1), 40);
  const backdateDays = Math.max(Number(c.req.query("backdateDays") ?? "0") || 0, 0);
  const force = c.req.query("force") === "1";

  const cfg = await getConfig(c.env);
  if (!cfg.pipeline.enabled && !force) {
    return c.json(
      { ok: false, error: "pipeline disabled (config); pass ?force=1 to override" },
      409,
    );
  }
  try {
    const report = await runBatch(c.env, {
      count,
      backdateDays,
      trigger: backdateDays > 0 ? "backfill" : "manual",
      config: cfg,
    });
    return c.json({ ok: true, report });
  } catch (err) {
    log.error("run.failed", { err: errStr(err) });
    return c.json({ ok: false, error: errStr(err) }, 500);
  }
});

// Drain the pending backlog NOW: fan out every pending queue item as its own
// GENERATE_QUEUE job (no ideation, no wall-clock throttle) so the consumer works
// through the whole backlog one article at a time. This is the "run everything"
// button - distinct from /run, which ideates fresh topics and produces inline.
// ?limit caps how many to dispatch (default 100, max 500).
api.post("/drain", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  if (!c.env.GENERATE_QUEUE) {
    return c.json({ ok: false, error: "queue not configured (GENERATE_QUEUE)" }, 503);
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100") || 100, 1), 500);
  const pending = await popPending(c.env, limit);

  let dispatched = 0;
  const errors: string[] = [];
  for (const item of pending) {
    let prepared;
    try {
      // Opens a 'running' pipeline_runs row + validates the item is still pending.
      prepared = await beginQueueItemRun(c.env, item.id);
    } catch (e) {
      errors.push(`#${item.id}: ${errStr(e)}`);
      continue;
    }
    try {
      await c.env.GENERATE_QUEUE.send({
        kind: "item",
        runId: prepared.runId,
        startedAt: prepared.startedAt,
        queueId: item.id,
      });
      dispatched++;
    } catch (e) {
      await reclaimRun(c.env, prepared.runId); // don't leave an orphaned 'running' row
      errors.push(`#${item.id}: enqueue failed: ${errStr(e)}`);
    }
  }
  log.info("api.drain", { dispatched, pending: pending.length, errors: errors.length });
  return c.json({ ok: true, dispatched, pending: pending.length, errors });
});

// Deep health check (authenticated): probes each binding and summarizes pipeline
// state. `GET /__health` stays a public, cheap liveness/binding check.
api.get("/health", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  const report = await healthReport(c.env);
  return c.json(report, report.ok ? 200 : 503);
});

// Bulk-submit every published URL to IndexNow (Bing/Yandex/Seznam). Run once to
// seed engines with the existing backlog, or after a bulk change. Per-publish
// pings happen automatically inside publishPost.
api.post("/indexnow", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  try {
    const result = await submitAllToIndexNow(c.env);
    return c.json(result);
  } catch (err) {
    log.error("indexnow.bulk_failed", { err: errStr(err) });
    return c.json({ ok: false, error: errStr(err) }, 500);
  }
});

// SEO backfill: assign clusters + add in-body internal links to existing posts.
// Chunked (each post is 2-3 LLM calls) - loop until the response's remaining=0.
// ?limit sets the chunk size (default 5, max 20).
api.post("/backfill-seo", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "5") || 5, 1), 20);
  try {
    const result = await backfillSeo(c.env, { limit });
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("backfill_seo.failed", { err: errStr(err) });
    return c.json({ ok: false, error: errStr(err) }, 500);
  }
});

// Bulk-rebuild the FTS5 index (run once after an FTS tokenizer migration).
api.post("/reindex", async (c) => {
  const denied = await authError(c);
  if (denied) return denied;
  try {
    const result = await reindexFts(c.env);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("reindex.failed", { err: errStr(err) });
    return c.json({ ok: false, error: "internal error" }, 500);
  }
});

// Length-independent-ish constant-time string compare (avoids leaking the token
// via early-return timing once lengths match).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
