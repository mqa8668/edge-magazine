import { Hono } from "hono";
import type { AppEnv } from "./env";
import { homeRoute } from "./routes/home";
import { categoryRoute } from "./routes/category";
import { postRoute } from "./routes/post";
import { tagRoute } from "./routes/tag";
import { authorRoute } from "./routes/author";
import { clusterRoute, clustersIndexRoute } from "./routes/cluster";
import { searchRoute } from "./routes/search";
import { newsletterRoute, newsletterSubscribe } from "./routes/newsletter";
import { STATIC_PAGES, staticPageRoute } from "./routes/pages";
import { aboutRoute } from "./routes/about";
import { legalPageRoute } from "./routes/legal";
import { uploadsRoute } from "./routes/uploads";
import { api } from "./api";
import { admin } from "./admin";
import {
  feedRoute,
  robotsRoute,
  sitemapAuthorsRoute,
  sitemapCategoriesRoute,
  sitemapClustersRoute,
  sitemapIndexRoute,
  sitemapNewsRoute,
  sitemapPagesRoute,
  sitemapPostsRoute,
  sitemapTagsRoute,
} from "./routes/xml";
import { indexNowKeyRoute } from "./seo/indexnow";
import { notFound } from "./routes/_shared";
import type { Bindings, GenerateJob } from "./env";
import { gte, inArray, sql } from "drizzle-orm";
import { db } from "./db/client";
import { contentQueue, posts } from "./db/schema";
import { planAndEnqueue, runBatch, runGenerateJob, type RunReport } from "./pipeline/generate";
import { popPending } from "./pipeline/queue";
import { log, errStr } from "./lib/log";
import { getConfig, type RuntimeConfig } from "./lib/runtime-config";
import { finishRun, reclaimStuck, recordSkippedRun, startRun } from "./pipeline/telemetry";
import { runWatchdog, sendAlert, sendTelegram } from "./lib/alerts";
import { sendHeartbeat } from "./pipeline/heartbeat";

// Pull a non-empty string field out of the Cloudflare request metadata
// (request.cf), tolerating its untyped/absent shape (cf is undefined in local dev).
function cfStr(cf: Record<string, unknown>, key: string): string | null {
  const v = cf[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

const app = new Hono<AppEnv>();

// Request access log: one structured line per handled request with visitor IP +
// geo + timing. Registered before all routes so it wraps every match. Skips the
// health probe and R2 image sub-requests (/uploads/*), which would multiply log
// volume - observability keeps every line (wrangler.toml head_sampling_rate=1) -
// without adding signal. Delete the skip line to capture those too.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const path = new URL(c.req.url).pathname;
  if (path === "/__health" || path.startsWith("/uploads/")) return;
  const cf = ((c.req.raw as { cf?: unknown }).cf ?? {}) as Record<string, unknown>;
  log.info("http.request", {
    method: c.req.method,
    path,
    status: c.res.status,
    ms: Date.now() - start,
    ip: c.req.header("cf-connecting-ip") ?? null,
    country: cfStr(cf, "country") ?? c.req.header("cf-ipcountry") ?? null,
    city: cfStr(cf, "city"),
    region: cfStr(cf, "region"),
    colo: cfStr(cf, "colo"),
    net: cfStr(cf, "asOrganization"),
    ref: c.req.header("referer") ?? null,
    ua: c.req.header("user-agent") ?? null,
  });
});

// Liveness + binding check.
app.get("/__health", (c) =>
  c.json({
    ok: true,
    phase: 1,
    site: c.env.SITE_URL,
    bindings: {
      DB: typeof c.env.DB?.prepare === "function",
      CACHE_KV: typeof c.env.CACHE_KV?.get === "function",
      UPLOADS: typeof c.env.UPLOADS?.get === "function",
    },
  }),
);

// Publish API (authenticated write path). Registered before the /:slug catch-all
// so /api/* never resolves as a category/article route.
app.route("/api", api);

// Admin panel (session auth; see src/admin). Also before /:slug so
// /admin never resolves as a category. Never linked from the public site.
app.route("/admin", admin);

// ── 1. Exact static / prefixed routes (resolved first, tech-spec §6) ─────────
app.get("/", homeRoute);

// XML / text endpoints
app.get("/robots.txt", robotsRoute);
app.get("/feed.xml", feedRoute);
app.get("/sitemap.xml", sitemapIndexRoute);
app.get("/sitemap-posts.xml", sitemapPostsRoute);
app.get("/sitemap-categories.xml", sitemapCategoriesRoute);
app.get("/sitemap-clusters.xml", sitemapClustersRoute);
app.get("/sitemap-tags.xml", sitemapTagsRoute);
app.get("/sitemap-authors.xml", sitemapAuthorsRoute);
app.get("/sitemap-pages.xml", sitemapPagesRoute);
app.get("/sitemap-news.xml", sitemapNewsRoute);
// IndexNow key file (/<key>.txt); registered after fixed *.txt/*.xml routes, before /:slug.
app.get("/:file{[A-Za-z0-9_-]+\\.txt}", indexNowKeyRoute);

// Images from R2
app.get("/uploads/*", uploadsRoute);

// Search + newsletter (placeholders in Phase 1)
app.get("/search", searchRoute);
app.get("/newsletter", newsletterRoute);
app.post("/newsletter", newsletterSubscribe);

// Redesigned custom pages with their own layouts: About, and the Legal hub
// (privacy/terms/cookie-policy share one sticky-sidebar layout). Registered
// before the generic loop, which then skips them.
app.get("/about", aboutRoute);
app.get("/privacy", legalPageRoute("privacy"));
app.get("/terms", legalPageRoute("terms"));
app.get("/cookie-policy", legalPageRoute("cookie-policy"));

// Remaining static content pages (contact, editorial-standards, write-for-us, dmca).
const CUSTOM_PAGES = new Set(["about", "privacy", "terms", "cookie-policy"]);
for (const slug of Object.keys(STATIC_PAGES)) {
  if (CUSTOM_PAGES.has(slug)) continue;
  app.get(`/${slug}`, staticPageRoute(slug));
}

// Prefixed list routes (static segment beats the bare :slug param)
app.get("/tags/:slug", tagRoute);
app.get("/authors/:slug", authorRoute);
app.get("/clusters", clustersIndexRoute);
app.get("/clusters/:slug", clusterRoute);

// ── 2. One-segment /:slug → category ─────────────────────────────────────────
app.get("/:slug", categoryRoute);

// ── 3. Two-segment /:category_slug/:post_slug → article ──────────────────────
app.get("/:categorySlug/:postSlug", postRoute);

// ── Fallbacks ────────────────────────────────────────────────────────────────
app.notFound(notFound);
app.onError((err, c) => {
  // Tag each 500 with a short id echoed to the client, so a user-reported error
  // can be found in the logs by that id.
  const reqId = crypto.randomUUID().slice(0, 8);
  const cf = ((c.req.raw as { cf?: unknown }).cf ?? {}) as Record<string, unknown>;
  log.error("http.error", {
    reqId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ip: c.req.header("cf-connecting-ip") ?? null,
    country: cfStr(cf, "country") ?? c.req.header("cf-ipcountry") ?? null,
    err: errStr(err),
  });
  return c.text(`Internal Server Error (ref ${reqId})`, 500);
});

// Cron trigger expressions (see wrangler.toml). The remaining cron
// ("0 1 * * *") is the daily content run. Branched below on cron id.
const HEARTBEAT_CRON = "30 13 * * *";
const TOPUP_CRON = "0 8 * * *"; // 15:00 VN - top up the day's missing posts

// Cron entry point (see wrangler.toml [triggers]). Only production has a cron;
// staging is triggered manually via POST /api/run for the voice-check backfill.
// Runs in the background so the schedule call returns.
//
// Two schedules share this handler, distinguished by `controller.cron`:
//  - HEARTBEAT_CRON -> push the daily Telegram health digest, nothing else.
//  - the content cron -> read runtime config (KV) each fire, honor the kill
//    switch (pipeline.enabled) + current postsPerDay, run the watchdog, generate,
//    and alert on a crash.
async function scheduled(
  controller: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === HEARTBEAT_CRON) {
    ctx.waitUntil(
      sendHeartbeat(env).catch((e) => log.error("heartbeat.crashed", { err: errStr(e) })),
    );
    return;
  }
  if (controller.cron === TOPUP_CRON) {
    // Afternoon top-up: the 08:00 run can under-deliver when dedup/safety kills
    // ideas faster than the backfill rounds replace them. Re-count what the day
    // still owes and fan out ONLY that - on-target days this is a no-op.
    ctx.waitUntil(
      (async () => {
        const cfg = await getConfig(env);
        if (!cfg.pipeline.enabled) {
          log.warn("topup.skipped_disabled", {});
          return;
        }
        try {
          const missing = await countMissingToday(env, cfg);
          if (missing <= 0) {
            log.info("topup.on_target", { postsPerDay: cfg.pipeline.postsPerDay });
            return;
          }
          log.info("topup.start", { missing });
          await runWatchdog(env, cfg);
          if (env.GENERATE_QUEUE) {
            await fanOutDailyRun(env, cfg, { count: missing, kind: "topup" });
          } else {
            await runBatch(env, { count: missing, trigger: "cron", config: cfg });
          }
        } catch (e) {
          log.error("topup.crashed", { err: errStr(e) });
          await sendAlert(env, "topup-crashed", "Top-up cron crashed", errStr(e));
        }
      })(),
    );
    return;
  }
  ctx.waitUntil(
    (async () => {
      const cfg = await getConfig(env);
      if (!cfg.pipeline.enabled) {
        log.warn("run.skipped_disabled", {});
        await recordSkippedRun(env, "cron");
        return;
      }
      try {
        await runWatchdog(env, cfg);
        if (env.GENERATE_QUEUE) {
          // Preferred path: ideate+enqueue once, then fan out ONE queue job per
          // item. Each item then gets its own fresh-budget consumer invocation
          // (no shared time budget, own subrequest limit, automatic retry), so a
          // postsPerDay of N actually produces N/day instead of the 1/day the
          // inline time budget allowed.
          await fanOutDailyRun(env, cfg);
        } else {
          // Fallback (local dev / queue unbound): inline batch, throttled by the
          // wall-clock time budget - only fully drains a small postsPerDay.
          const report = await runBatch(env, {
            count: cfg.pipeline.postsPerDay,
            trigger: "cron",
            config: cfg,
          });
          log.info("run.finish", {
            runId: report.runId,
            status: report.status,
            published: report.published.length,
            failed: report.failed.length,
          });
        }
      } catch (e) {
        log.error("run.crashed", { err: errStr(e) });
        await sendAlert(env, "run-crashed", "Content cron run crashed", errStr(e));
      }
    })(),
  );
}

// Cron fan-out: run ideation+enqueue under one "planning" run row, then dispatch
// one GENERATE_QUEUE job per pending item (oldest first, so the backlog drains).
// The queue consumer (runGenerateJob -> runPreparedItem) produces each item in
// its own invocation. Each dispatched item gets its own pipeline_runs row so the
// admin dashboard shows per-article progress, exactly like the "Chay ngay" button.
async function fanOutDailyRun(
  env: Bindings,
  cfg: RuntimeConfig,
  opts: { count?: number; kind?: "daily" | "topup" } = {},
): Promise<void> {
  const count = opts.count ?? cfg.pipeline.postsPerDay;
  const kind = opts.kind ?? "daily";

  // 1. Planning run: reclaim stuck items, ideate + enqueue new topics.
  const { runId, startedAt } = await startRun(env, "cron");
  const report: RunReport = {
    runId,
    status: "running",
    requested: count,
    ideated: 0,
    enqueued: 0,
    skippedDuplicates: 0,
    published: [],
    failed: [],
    held: [],
  };
  try {
    await reclaimStuck(env);
    await planAndEnqueue(env, cfg, count, runId, report);
    await finishRun(env, { runId, startedAt, status: "ok", report });
  } catch (e) {
    await finishRun(env, { runId, startedAt, status: "failed", report, error: errStr(e) });
    throw e;
  }

  // 2. Fan out: one queue job per pending item, up to postsPerDay, oldest first.
  const pending = await popPending(env, count);
  let dispatched = 0;
  for (const item of pending) {
    const run = await startRun(env, "cron");
    try {
      await env.GENERATE_QUEUE!.send({
        kind: "item",
        runId: run.runId,
        startedAt: run.startedAt,
        queueId: item.id,
      });
      dispatched++;
    } catch (e) {
      // Don't leave an orphaned 'running' row if the send failed.
      await finishRun(env, {
        runId: run.runId,
        startedAt: run.startedAt,
        status: "failed",
        error: `fan-out enqueue failed: ${errStr(e)}`,
      });
      log.error("cron.fanout_enqueue_failed", { queueId: item.id, err: errStr(e) });
    }
  }
  log.info("cron.fanout", { enqueued: report.enqueued, dispatched, pending: pending.length });

  // Per-cron Telegram ping (once/day): the morning cron fired and here is what it
  // queued. Real-time "it is working" signal; final publish counts land in the
  // 20:30 health digest. Best-effort (sendTelegram never throws), and it skips
  // itself when Telegram is not configured/selected as a channel.
  const cfgNow = await getConfig(env);
  if (cfgNow.alerts.enabled && cfgNow.alerts.channels.includes("telegram")) {
    const heading =
      kind === "topup"
        ? `Top-up cron (15:00) ran: ${count} articles short of the daily target`
        : "Content cron ran";
    await sendTelegram(
      env,
      `[${env.SITE_NAME || "Edge Magazine"}] ${heading}\n` +
        `Planned ${count}, ideated ${report.ideated}, enqueued ${report.enqueued} ` +
        `(duplicates ${report.skippedDuplicates}), dispatched ${dispatched} jobs.\n` +
        `Publish results will be summarized in the 20:30 digest.`,
    );
  }
}

// How many posts today's target still misses. "Today" is the Vietnam calendar
// day (the 08:00 cron and the 15:00 top-up both live inside it). In-flight
// queue items (pending/generating) count as delivered - they publish within
// the hour - so the top-up never double-orders work the morning run already
// queued. Review mode returns 0: held drafts wait on a human, and topping up
// would only pile more drafts behind the same bottleneck.
async function countMissingToday(env: Bindings, cfg: RuntimeConfig): Promise<number> {
  if (cfg.publish.mode !== "auto") return 0;
  const VN_OFFSET_MS = 7 * 3_600_000;
  const DAY_MS = 24 * 3_600_000;
  const dayStartIso = new Date(
    Math.floor((Date.now() + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS,
  ).toISOString();
  const d = db(env.DB);
  const [pub, inFlight] = await Promise.all([
    d
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(gte(posts.publishedAt, dayStartIso))
      .get(),
    d
      .select({ n: sql<number>`count(*)` })
      .from(contentQueue)
      .where(inArray(contentQueue.status, ["pending", "generating"]))
      .get(),
  ]);
  return cfg.pipeline.postsPerDay - (pub?.n ?? 0) - (inFlight?.n ?? 0);
}

// Queue consumer for background content generation (see wrangler.toml
// [[queues.consumers]]). A consumer invocation gets a scheduled-grade budget, so
// generation that the fetch-handler waitUntil budget was too short for runs
// reliably here. max_batch_size=1, so each batch has a single message.
async function queue(
  batch: MessageBatch<GenerateJob>,
  env: Bindings,
): Promise<void> {
  for (const msg of batch.messages) {
    log.info("queue.consume", { job: msg.body });
    await runGenerateJob(env, msg.body);
    msg.ack();
  }
}

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) =>
    app.fetch(req, env, ctx),
  scheduled,
  queue,
};
