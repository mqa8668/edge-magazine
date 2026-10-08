// Admin panel router (mounted at /admin, BEFORE the /:slug catch-all).
// Auth: single admin, password (ADMIN_PASSWORD_HASH) -> HMAC-signed cookie
// session (SESSION_SECRET). Every mutating route checks a CSRF token on top of
// SameSite=Strict. Every response carries X-Robots-Tag: noindex.

import { Hono } from "hono";
import type { Context } from "hono";
import type { Bindings } from "../env";
import { log, errStr } from "../lib/log";
import { clientIp, rateLimit } from "../lib/ratelimit";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionToken,
  csrfToken,
  readCookie,
  sessionCookie,
  verifyCsrf,
  verifyPassword,
  verifySessionToken,
  type Session,
} from "../lib/session";
import { getConfig, setConfig, configSource } from "../lib/runtime-config";
import { healthReport, reclaimRun, startRun } from "../pipeline/telemetry";
import { beginQueueItemRun, publishGenerated, type GeneratedArticle } from "../pipeline/generate";
import { chat } from "../pipeline/llm";
import { fetchPhoto } from "../pipeline/photos";
import { sendTelegram } from "../lib/alerts";
import { sendHeartbeat } from "../pipeline/heartbeat";
import { enqueueTopics, markFailed, queueStats } from "../pipeline/queue";
import { deletePost, reindexFts } from "../api/publish";
import { db } from "../db/client";
import { categories } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  BULK_RETRY_ATTEMPTS_CAP,
  dailyLlmCost,
  dashboardData,
  getQueueItem,
  getRun,
  listConfigAudit,
  listLlmCalls,
  listNotifications,
  listPosts,
  listQueue,
  listReview,
  listRuns,
  llmGatewayStatus,
  markNotificationsRead,
  navCounts,
  parseConfigForm,
  purgePost,
  purgeSiteCaches,
  requeueAllFailed,
  requeueItem,
  setPriority,
  skipItem,
  toggleFeatured,
  unreadNotificationCount,
} from "./data";
import { AdminLayout, LoginPage, PipelineBanner, adminHtml, flashOf, setBranding, type Flash } from "./ui";
import { AlertsPage, DashboardPage, QueuePage, RunDetailPage, RunsPage } from "./pages-ops";
import {
  ConfigPage,
  LlmPage,
  PostsPage,
  ReviewDetailPage,
  ReviewPage,
  ToolsPage,
  parseHeldDraft,
} from "./pages-manage";

export type AdminEnv = {
  Bindings: Bindings;
  Variables: {
    session: Session;
    csrf: string;
    nav?: { review: number; posts: number; unread?: number };
  };
};

type Ctx = Context<AdminEnv>;

export const admin = new Hono<AdminEnv>();

// Keep the panel out of every index, whatever the response.
admin.use("*", async (c, next) => {
  setBranding(c.env.SITE_NAME, c.env.SITE_URL || c.req.url);
  await next();
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});

// Session gate for everything except the login screen.
admin.use("*", async (c, next) => {
  if (c.req.path === "/admin/login") return next();
  const secret = c.env.SESSION_SECRET;
  if (!secret || !c.env.ADMIN_PASSWORD_HASH) {
    return c.text(
      "Admin is not configured (ADMIN_PASSWORD_HASH and SESSION_SECRET are required)",
      503,
    );
  }
  const session = await verifySessionToken(
    secret,
    readCookie(c.req.header("cookie"), SESSION_COOKIE),
  );
  if (!session) {
    if (c.req.method === "GET") return c.redirect("/admin/login");
    return c.text("unauthorized", 401);
  }
  c.set("session", session);
  c.set("csrf", await csrfToken(secret, session));
  // Sidebar nav badges (drafts awaiting review + live post count) + bell unread
  // count. GET only.
  if (c.req.method === "GET") {
    const [nav, unread] = await Promise.all([
      navCounts(c.env).catch(() => ({ review: 0, posts: 0 })),
      unreadNotificationCount(c.env).catch(() => 0),
    ]);
    c.set("nav", { ...nav, unread });
  }
  return next();
});

// Parse the form and enforce the CSRF token for a mutating route. Returns the
// form, or null after setting a 403 (caller returns immediately).
async function formWithCsrf(c: Ctx): Promise<FormData | null> {
  const form = await c.req.formData();
  const ok = await verifyCsrf(
    c.env.SESSION_SECRET ?? "",
    c.get("session"),
    form.get("csrf")?.toString(),
  );
  if (!ok) return null;
  return form;
}

function redirectFlash(c: Ctx, path: string, f: Flash) {
  const qs = new URLSearchParams();
  if (f.msg) qs.set("msg", f.msg);
  if (f.err) qs.set("err", f.err);
  const q = qs.toString();
  return c.redirect(q ? `${path}?${q}` : path);
}

function intParam(c: Ctx): number | null {
  const n = Number(c.req.param("id"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Login / logout ───────────────────────────────────────────────────────────

admin.get("/login", (c) => {
  return adminHtml(c, <LoginPage err={c.req.query("err") || undefined} />);
});

admin.post("/login", async (c) => {
  const secret = c.env.SESSION_SECRET;
  const hash = c.env.ADMIN_PASSWORD_HASH;
  if (!secret || !hash) return c.text("Admin is not configured", 503);

  const ip = clientIp(c.req.raw);
  const rl = await rateLimit(c.env, "admin-login", ip, 5, 600);
  if (!rl.allowed) {
    log.warn("admin.login_rate_limited", { ip });
    return adminHtml(
      c,
      <LoginPage err={`Too many failed attempts. Try again in ${rl.retryAfterSeconds}s.`} />,
      429,
    );
  }

  const form = await c.req.formData();
  const password = form.get("password")?.toString() ?? "";
  if (!(await verifyPassword(password, hash))) {
    log.warn("admin.login_failed", { ip });
    return adminHtml(c, <LoginPage err="Wrong password." />, 401);
  }

  const token = await createSessionToken(secret);
  c.header("Set-Cookie", sessionCookie(token));
  log.info("admin.login", { ip });
  return c.redirect("/admin");
});

admin.post("/logout", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  c.header("Set-Cookie", clearSessionCookie());
  log.info("admin.logout", {});
  return c.redirect("/admin/login");
});

// ── Dashboard ────────────────────────────────────────────────────────────────

admin.get("/", async (c) => {
  const [d, daily, recentRuns] = await Promise.all([
    dashboardData(c.env),
    dailyLlmCost(c.env, 10),
    listRuns(c.env, 5),
  ]);
  return adminHtml(
    c,
    <AdminLayout title="Overview" path="/admin" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <PipelineBanner enabled={d.config.pipeline.enabled} mode={d.config.publish.mode} />
      <DashboardPage d={d} daily={daily} recentRuns={recentRuns} />
    </AdminLayout>,
  );
});

// ── Runs ─────────────────────────────────────────────────────────────────────

admin.get("/runs", async (c) => {
  const runs = await listRuns(c.env);
  return adminHtml(
    c,
    <AdminLayout title="Runs" path="/admin/runs" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <RunsPage runs={runs} />
    </AdminLayout>,
  );
});

admin.get("/runs/:id", async (c) => {
  const { run, calls, phase, items, ideas } = await getRun(c.env, c.req.param("id"));
  if (!run) return redirectFlash(c, "/admin/runs", { err: "Run not found." });
  // While a run is still in flight, poll it with a light meta-refresh so the
  // operator can watch the pipeline (phase heartbeat + queue items) without JS.
  const refresh = run.status === "running" ? 4 : undefined;
  return adminHtml(
    c,
    <AdminLayout
      title={`Run ${run.id.slice(0, 8)}`}
      path="/admin/runs"
      flash={flashOf(c)}
      csrf={c.get("csrf")}
      navCounts={c.get("nav")}
      refresh={refresh}
    >
      <RunDetailPage run={run} calls={calls} phase={phase} items={items} ideas={ideas} csrf={c.get("csrf")} />
    </AdminLayout>,
  );
});

// ── Notifications / alerts ───────────────────────────────────────────────────

admin.get("/alerts", async (c) => {
  const items = await listNotifications(c.env, 100);
  return adminHtml(
    c,
    <AdminLayout title="Notifications" path="/admin/alerts" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <AlertsPage items={items} csrf={c.get("csrf")} />
    </AdminLayout>,
  );
});

// Mark all notifications read (clears the bell badge).
admin.post("/alerts/read", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  await markNotificationsRead(c.env);
  return redirectFlash(c, "/admin/alerts", { msg: "All notifications marked as read." });
});

// Mark one notification read, then follow its deep link if it has one.
admin.post("/alerts/:id/read", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/alerts", { err: "Invalid ID." });
  await markNotificationsRead(c.env, id);
  const href = form.get("href")?.toString();
  return c.redirect(href && href.startsWith("/admin/") ? href : "/admin/alerts");
});

// Force-fail a stuck run + return its in-flight items to the queue (manual
// version of the watchdog, so the operator does not have to wait ~15 min).
admin.post("/runs/:id/reclaim", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = c.req.param("id");
  const n = await reclaimRun(c.env, id);
  log.warn("admin.run_reclaim", { id, items: n });
  return redirectFlash(c, `/admin/runs/${id}`, {
    msg: `Run cancelled (marked failed, ${n} items returned to pending).`,
  });
});

// ── Queue ────────────────────────────────────────────────────────────────────

async function activeCategories(env: Bindings) {
  return db(env.DB)
    .select({ slug: categories.slug, name: categories.name })
    .from(categories)
    .where(eq(categories.isActive, 1))
    .orderBy(categories.position)
    .all();
}

admin.get("/queue", async (c) => {
  const status = c.req.query("status") ?? "";
  const category = c.req.query("category") ?? "";
  const [items, cats, stats] = await Promise.all([
    listQueue(c.env, {
      status: status || undefined,
      category: category || undefined,
    }),
    activeCategories(c.env),
    queueStats(c.env),
  ]);
  return adminHtml(
    c,
    <AdminLayout title="Queue" path="/admin/queue" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <QueuePage
        items={items}
        categories={cats}
        filterStatus={status}
        filterCategory={category}
        failedCount={stats.byStatus.failed ?? 0}
        csrf={c.get("csrf")}
      />
    </AdminLayout>,
  );
});

admin.post("/queue/new", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const topic = form.get("topic")?.toString().trim() ?? "";
  const category = form.get("category")?.toString().trim() ?? "";
  const keyword = form.get("keyword")?.toString().trim() || undefined;
  if (!topic || !category) {
    return redirectFlash(c, "/admin/queue", { err: "Topic or category is missing." });
  }
  const report = await enqueueTopics(c.env, [
    { topic, categorySlug: category, keyword, priority: 5, source: "manual" },
  ]);
  log.info("admin.queue_add", { topic, category, inserted: report.inserted.length });
  if (report.inserted.length) {
    return redirectFlash(c, "/admin/queue", {
      msg: `Added "#${report.inserted[0].id} ${topic}" to the queue.`,
    });
  }
  return redirectFlash(c, "/admin/queue", {
    err: `Rejected (${report.skipped[0]?.reason ?? "duplicate"}): ${topic}`,
  });
});

// Run one pending queue item now. Generation is slow (~20-90s) and a fetch
// handler's waitUntil budget (~25-30s) is too short - it was orphaning runs. So
// we open the run row synchronously (to redirect to it) and hand the actual work
// to the QUEUE, whose consumer gets a scheduled-grade budget. The run page then
// shows live progress (phase heartbeat) as the consumer works.
admin.post("/queue/:id/run", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/queue", { err: "Invalid ID." });
  if (!c.env.GENERATE_QUEUE) {
    return redirectFlash(c, "/admin/queue", { err: "Job queue is not configured (GENERATE_QUEUE)." });
  }
  let prepared;
  try {
    prepared = await beginQueueItemRun(c.env, id);
  } catch (e) {
    return redirectFlash(c, "/admin/queue", { err: errStr(e) });
  }
  try {
    await c.env.GENERATE_QUEUE.send({
      kind: "item",
      runId: prepared.runId,
      startedAt: prepared.startedAt,
      queueId: id,
    });
  } catch (e) {
    await reclaimRun(c.env, prepared.runId); // don't leave an orphaned 'running' row
    return redirectFlash(c, "/admin/queue", { err: `Could not enqueue: ${errStr(e)}` });
  }
  log.info("admin.queue_run_enqueued", { id, runId: prepared.runId });
  return redirectFlash(c, `/admin/runs/${prepared.runId}`, {
    msg: "Queued - processing in the background; this page refreshes automatically.",
  });
});

admin.post("/queue/:id/retry", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/queue", { err: "Invalid ID." });
  await requeueItem(c.env, id);
  log.info("admin.queue_retry", { id });
  return redirectFlash(c, "/admin/queue", { msg: `#${id} is back to pending.` });
});

// Bulk re-drive: every failed row (attempts < cap) back to pending, then hand
// each one to the QUEUE right away with the exact fan-out message the daily
// cron sends - so they process in the background now, not at the next cron.
// Poison rows (attempts >= cap) are skipped; the per-row retry overrides them.
admin.post("/queue/retry-failed", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  if (!c.env.GENERATE_QUEUE) {
    return redirectFlash(c, "/admin/queue", { err: "Job queue is not configured (GENERATE_QUEUE)." });
  }
  const { requeued, skippedPoison, ids } = await requeueAllFailed(c.env);
  let dispatched = 0;
  for (const queueId of ids) {
    const run = await startRun(c.env, "manual");
    try {
      await c.env.GENERATE_QUEUE.send({
        kind: "item",
        runId: run.runId,
        startedAt: run.startedAt,
        queueId,
      });
      dispatched++;
    } catch (e) {
      // Don't leave an orphaned 'running' row; the item stays pending and the
      // next cron fan-out will pick it up instead.
      await reclaimRun(c.env, run.runId);
      log.error("admin.queue_retry_failed_dispatch", { queueId, err: errStr(e) });
    }
  }
  log.info("admin.queue_retry_failed", { requeued, skippedPoison, dispatched });
  if (!requeued && !skippedPoison) {
    return redirectFlash(c, "/admin/queue", { msg: "No failed jobs to retry." });
  }
  const parts = [`Requeued ${requeued} failed jobs (${dispatched} dispatched to the background queue)`];
  if (skippedPoison) {
    parts.push(`skipped ${skippedPoison} jobs already tried ${BULK_RETRY_ATTEMPTS_CAP}+ times`);
  }
  return redirectFlash(c, "/admin/queue", { msg: parts.join("; ") + "." });
});

admin.post("/queue/:id/skip", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/queue", { err: "Invalid ID." });
  await skipItem(c.env, id);
  log.info("admin.queue_skip", { id });
  return redirectFlash(c, "/admin/queue", { msg: `#${id} skipped (no article will be generated).` });
});

admin.post("/queue/:id/priority", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  const priority = Number(form.get("priority"));
  if (id == null || !Number.isInteger(priority) || priority < 0 || priority > 99) {
    return redirectFlash(c, "/admin/queue", { err: "Invalid priority (0-99)." });
  }
  await setPriority(c.env, id, priority);
  log.info("admin.queue_priority", { id, priority });
  return redirectFlash(c, "/admin/queue", { msg: `#${id} priority = ${priority}.` });
});

// ── Review ───────────────────────────────────────────────────────────────────

admin.get("/review", async (c) => {
  const [items, cfg] = await Promise.all([listReview(c.env), getConfig(c.env)]);
  return adminHtml(
    c,
    <AdminLayout title="Review" path="/admin/review" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <ReviewPage items={items} reviewMode={cfg.publish.mode === "review"} />
    </AdminLayout>,
  );
});

admin.get("/review/:id", async (c) => {
  const id = intParam(c);
  const item = id != null ? await getQueueItem(c.env, id) : null;
  if (!item || item.status !== "awaiting_review") {
    return redirectFlash(c, "/admin/review", { err: "This item is not awaiting review." });
  }
  return adminHtml(
    c,
    <AdminLayout
      title={`Duyet #${item.id}`}
      path="/admin/review"
      flash={flashOf(c)}
      csrf={c.get("csrf")}
      navCounts={c.get("nav")}
    >
      <ReviewDetailPage item={item} draft={parseHeldDraft(item.draftJson)} csrf={c.get("csrf")} />
    </AdminLayout>,
  );
});

admin.post("/review/:id/approve", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  const item = id != null ? await getQueueItem(c.env, id) : null;
  if (!item || item.status !== "awaiting_review") {
    return redirectFlash(c, "/admin/review", { err: "This item is not awaiting review." });
  }
  const draft = parseHeldDraft(item.draftJson);
  if (!draft) {
    return redirectFlash(c, "/admin/review", { err: `#${item.id} has no valid draft.` });
  }
  try {
    const cats = await activeCategories(c.env);
    const article: GeneratedArticle = { ...draft };
    const out = await publishGenerated(c.env, article, {
      queueId: item.id,
      categorySlug: item.categorySlug,
      personaSlug: item.personaSlug ?? "mia-tran",
      categoryName: cats.find((x) => x.slug === item.categorySlug)?.name,
    });
    log.info("admin.review_approve", { id: item.id, slug: out.slug });
    return redirectFlash(c, "/admin/review", { msg: `Published: ${out.slug}` });
  } catch (e) {
    log.error("admin.review_approve_failed", { id: item.id, err: errStr(e) });
    return redirectFlash(c, "/admin/review", { err: `Publish failed: ${errStr(e)}` });
  }
});

admin.post("/review/:id/reject", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  const item = id != null ? await getQueueItem(c.env, id) : null;
  if (!item || item.status !== "awaiting_review") {
    return redirectFlash(c, "/admin/review", { err: "This item is not awaiting review." });
  }
  const reason = form.get("reason")?.toString().trim() || "rejected by admin";
  await markFailed(c.env, item.id, `rejected: ${reason}`);
  log.info("admin.review_reject", { id: item.id, reason });
  return redirectFlash(c, "/admin/review", { msg: `Rejected #${item.id}.` });
});

// ── Posts ────────────────────────────────────────────────────────────────────

admin.get("/posts", async (c) => {
  const rows = await listPosts(c.env);
  return adminHtml(
    c,
    <AdminLayout title="Posts" path="/admin/posts" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <PostsPage posts={rows} csrf={c.get("csrf")} />
    </AdminLayout>,
  );
});

admin.post("/posts/:id/feature", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/posts", { err: "Invalid ID." });
  await toggleFeatured(c.env, id);
  log.info("admin.post_feature_toggle", { id });
  return redirectFlash(c, "/admin/posts", { msg: `Toggled featured for #${id}.` });
});

admin.post("/posts/:id/purge", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/posts", { err: "Invalid ID." });
  await purgePost(c.env, id);
  log.info("admin.post_purge", { id });
  return redirectFlash(c, "/admin/posts", { msg: `Purged cache for #${id}.` });
});

admin.post("/posts/:id/delete", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const id = intParam(c);
  if (id == null) return redirectFlash(c, "/admin/posts", { err: "Invalid ID." });
  if (form.get("confirm") !== "on") {
    return redirectFlash(c, "/admin/posts", {
      err: "Confirmation box not ticked - the post was not unpublished.",
    });
  }
  try {
    const out = await deletePost(c.env, id);
    log.warn("admin.post_delete", { id, slug: out.slug });
    return redirectFlash(c, "/admin/posts", { msg: `Unpublished: ${out.slug}` });
  } catch (e) {
    return redirectFlash(c, "/admin/posts", { err: errStr(e) });
  }
});

// ── Config ───────────────────────────────────────────────────────────────────

admin.get("/config", async (c) => {
  const [cfg, source, audit] = await Promise.all([
    getConfig(c.env),
    configSource(c.env),
    listConfigAudit(c.env),
  ]);
  return adminHtml(
    c,
    <AdminLayout title="Config" path="/admin/config" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <PipelineBanner enabled={cfg.pipeline.enabled} mode={cfg.publish.mode} />
      <ConfigPage cfg={cfg} source={source} audit={audit} csrf={c.get("csrf")} />
    </AdminLayout>,
  );
});

admin.post("/config", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const { patch, errors } = parseConfigForm(form);
  if (errors.length) {
    return redirectFlash(c, "/admin/config", { err: errors.join(" | ") });
  }
  const { diff } = await setConfig(c.env, patch, "admin");
  const n = Object.keys(diff).length;
  return redirectFlash(c, "/admin/config", {
    msg: n ? `Config saved (${n} keys changed).` : "Saved - nothing changed.",
  });
});

// ── LLM ──────────────────────────────────────────────────────────────────────

admin.get("/llm", async (c) => {
  const provider = c.req.query("provider") ?? "";
  const stage = c.req.query("stage") ?? "";
  const ok = c.req.query("ok") ?? "";
  const [calls, daily, gateway] = await Promise.all([
    listLlmCalls(c.env, {
      provider: provider || undefined,
      stage: stage || undefined,
      ok: ok === "1" || ok === "0" ? ok : undefined,
    }),
    dailyLlmCost(c.env),
    llmGatewayStatus(c.env),
  ]);
  return adminHtml(
    c,
    <AdminLayout title="LLM" path="/admin/llm" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <LlmPage
        calls={calls}
        daily={daily}
        gateway={gateway}
        filterProvider={provider}
        filterStage={stage}
        filterOk={ok}
      />
    </AdminLayout>,
  );
});

// ── Tools ────────────────────────────────────────────────────────────────────

admin.get("/tools", async (c) => {
  const health = await healthReport(c.env);
  return adminHtml(
    c,
    <AdminLayout title="Tools" path="/admin/tools" flash={flashOf(c)} csrf={c.get("csrf")} navCounts={c.get("nav")}>
      <ToolsPage csrf={c.get("csrf")} health={health} />
    </AdminLayout>,
  );
});

admin.post("/tools/run", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const count = Math.min(Math.max(Number(form.get("count")) || 1, 1), 5);
  const force = form.get("force") === "on";
  const cfg = await getConfig(c.env);
  if (!cfg.pipeline.enabled && !force) {
    return redirectFlash(c, "/admin/tools", {
      err: "The drafting assistant is off - tick force to run anyway.",
    });
  }
  // Batch generation is slow; enqueue it (same reason as the queue "Chay ngay"
  // route - the fetch-handler waitUntil budget is too short). Open the run row
  // now so we can redirect to it; the queue consumer runs the batch.
  if (!c.env.GENERATE_QUEUE) {
    return redirectFlash(c, "/admin/tools", { err: "Job queue is not configured (GENERATE_QUEUE)." });
  }
  const { runId, startedAt } = await startRun(c.env, "manual");
  try {
    await c.env.GENERATE_QUEUE.send({ kind: "batch", runId, startedAt, count });
  } catch (e) {
    await reclaimRun(c.env, runId);
    return redirectFlash(c, "/admin/tools", { err: `Could not enqueue: ${errStr(e)}` });
  }
  log.info("admin.tools_run_enqueued", { count, runId });
  return redirectFlash(c, `/admin/runs/${runId}`, {
    msg: `Queued ${count} items - processing in the background; this page refreshes automatically.`,
  });
});

admin.post("/tools/reindex", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const { indexed } = await reindexFts(c.env);
  log.info("admin.tools_reindex", { indexed });
  return redirectFlash(c, "/admin/tools", { msg: `FTS reindexed (${indexed} posts).` });
});

admin.post("/tools/purge", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const n = await purgeSiteCaches(c.env);
  log.info("admin.tools_purge", { urls: n });
  return redirectFlash(c, "/admin/tools", { msg: `Purged ${n} URLs + KV payloads.` });
});

admin.post("/tools/test-llm", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const t0 = Date.now();
  try {
    const r = await chat(c.env, {
      system: "Ban la cong cu kiem tra ket noi. Tra loi that ngan.",
      user: "Tra loi dung mot tu: OK",
      maxTokens: 20,
      temperature: 0,
      track: { stage: "test" },
    });
    return redirectFlash(c, "/admin/tools", {
      msg: `LLM ok: ${r.provider}/${r.model} replied "${r.text.slice(0, 40)}" in ${Date.now() - t0}ms.`,
    });
  } catch (e) {
    return redirectFlash(c, "/admin/tools", { err: `LLM error: ${errStr(e)}` });
  }
});

admin.post("/tools/test-photo", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  try {
    const photo = await fetchPhoto(c.env, { query: "morning light window" });
    if (!photo) {
      return redirectFlash(c, "/admin/tools", {
        err: "Photo API returned nothing (missing key or quota exhausted).",
      });
    }
    return redirectFlash(c, "/admin/tools", {
      msg: `Photo ok: ${photo.id} (${photo.width}x${photo.height}) by ${photo.creditName}.`,
    });
  } catch (e) {
    return redirectFlash(c, "/admin/tools", { err: `Photo error: ${errStr(e)}` });
  }
});

// Send a plain Telegram ping - proves the bot token + chat id + channel wiring
// deliver end-to-end (there is no other way to exercise sendTelegram on demand).
admin.post("/tools/test-telegram", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  const r = await sendTelegram(
    c.env,
    `[${c.env.SITE_NAME || "Edge Magazine"}] Test message from /admin/tools - if you can read this, the Telegram channel works.`,
  );
  if (r === "ok") {
    return redirectFlash(c, "/admin/tools", { msg: "Telegram ok: sent - check your phone." });
  }
  return redirectFlash(c, "/admin/tools", {
    err: `Telegram send failed: ${r} (skip = secret not set or the telegram channel is not enabled in config).`,
  });
});

// Build + send the full daily health digest right now (same message the 20:30
// cron pushes), so the operator can verify the digest and its Telegram delivery.
admin.post("/tools/heartbeat", async (c) => {
  const form = await formWithCsrf(c);
  if (!form) return c.text("csrf", 403);
  try {
    const { status, telegram } = await sendHeartbeat(c.env);
    return redirectFlash(c, "/admin/tools", {
      msg: `Digest (${status}) - Telegram: ${telegram}. Saved to the Notifications feed.`,
    });
  } catch (e) {
    return redirectFlash(c, "/admin/tools", { err: `Digest error: ${errStr(e)}` });
  }
});
