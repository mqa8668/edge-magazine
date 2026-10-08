// Admin panel data layer: read models for each page and the write actions the
// forms post. Pages are read-heavy over the B2 telemetry tables; actions reuse
// the pipeline/publish modules so admin behavior is identical to the pipeline's.

import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  categories,
  configAudit,
  contentQueue,
  llmCalls,
  notifications,
  pipelineIdeas,
  pipelineRuns,
  posts,
  type ContentQueueItem,
  type LlmCall,
  type Notification,
  type PipelineIdea,
  type PipelineRun,
} from "../db/schema";
import type { Bindings } from "../env";
import { purgeKvKeys, purgeUrls } from "../lib/cache";
import { absUrl, routes, siteConfig } from "../lib/config";
import { STALE_KV_KEYS } from "../api/publish";
import {
  configSource,
  getConfig,
  type DeepPartial,
  type RuntimeConfig,
} from "../lib/runtime-config";
import { getRunPhase, lastRun, llmStats, type LlmStats, type RunPhase } from "../pipeline/telemetry";
import { queueStats } from "../pipeline/queue";
import { readCircuit } from "../pipeline/llm";
import { CB_CLOSED, isCircuitOpen } from "../pipeline/llm-policy";

const DAY_MS = 24 * 60 * 60_000;

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardData {
  lastRun: PipelineRun | null;
  queueByStatus: Record<string, number>;
  pendingByCategory: Record<string, number>;
  postsTotal: number;
  postsByCategory: { slug: string; name: string; count: number }[];
  runs7d: { runs: number; requested: number; published: number; failed: number };
  cost7d: LlmStats;
  cost30d: LlmStats;
  awaitingReview: number;
  activeAlerts: string[]; // alert types inside their 6h dedup window
  configSource: "kv" | "default";
  config: RuntimeConfig;
}

export async function dashboardData(env: Bindings): Promise<DashboardData> {
  const d = db(env.DB);
  const now = Date.now();

  const [run, queue, cats, runRows, c7, c30, review, alerts, cfg, source] =
    await Promise.all([
      lastRun(env),
      queueStats(env),
      d
        .select({ slug: categories.slug, name: categories.name, count: categories.postCount })
        .from(categories)
        .where(eq(categories.isActive, 1))
        .orderBy(categories.position)
        .all(),
      d
        .select({
          requested: sql<number>`coalesce(sum(${pipelineRuns.requested}), 0)`,
          published: sql<number>`coalesce(sum(${pipelineRuns.published}), 0)`,
          failed: sql<number>`coalesce(sum(${pipelineRuns.failed}), 0)`,
          runs: sql<number>`count(*)`,
        })
        .from(pipelineRuns)
        .where(gte(pipelineRuns.startedAt, now - 7 * DAY_MS))
        .get(),
      llmStats(env, now - 7 * DAY_MS),
      llmStats(env, now - 30 * DAY_MS),
      d
        .select({ n: sql<number>`count(*)` })
        .from(contentQueue)
        .where(eq(contentQueue.status, "awaiting_review"))
        .get(),
      env.CACHE_KV.list({ prefix: "alert:" }).catch(() => ({ keys: [] as { name: string }[] })),
      getConfig(env),
      configSource(env),
    ]);

  return {
    lastRun: run,
    queueByStatus: queue.byStatus,
    pendingByCategory: queue.pendingByCategory,
    postsTotal: cats.reduce((s, c) => s + c.count, 0),
    postsByCategory: cats,
    runs7d: {
      runs: runRows?.runs ?? 0,
      requested: runRows?.requested ?? 0,
      published: runRows?.published ?? 0,
      failed: runRows?.failed ?? 0,
    },
    cost7d: c7,
    cost30d: c30,
    awaitingReview: review?.n ?? 0,
    activeAlerts: alerts.keys.map((k) => k.name.slice("alert:".length)),
    configSource: source,
    config: cfg,
  };
}

// Cheap counts for the sidebar nav badges (review = drafts awaiting, posts =
// live post total). Computed per authed GET request in the admin middleware.
export async function navCounts(env: Bindings): Promise<{ review: number; posts: number }> {
  const d = db(env.DB);
  const [rev, pos] = await Promise.all([
    d
      .select({ n: sql<number>`count(*)` })
      .from(contentQueue)
      .where(eq(contentQueue.status, "awaiting_review"))
      .get(),
    d
      .select({ n: sql<number>`coalesce(sum(${categories.postCount}), 0)` })
      .from(categories)
      .where(eq(categories.isActive, 1))
      .get(),
  ]);
  return { review: rev?.n ?? 0, posts: pos?.n ?? 0 };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export async function listRuns(env: Bindings, limit = 30): Promise<PipelineRun[]> {
  return db(env.DB)
    .select()
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit)
    .all();
}

export async function getRun(
  env: Bindings,
  id: string,
): Promise<{
  run: PipelineRun | null;
  calls: LlmCall[];
  phase: RunPhase | null;
  items: ContentQueueItem[];
  ideas: PipelineIdea[];
}> {
  const d = db(env.DB);
  const [run, calls, phase, items, ideas] = await Promise.all([
    d.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get(),
    d.select().from(llmCalls).where(eq(llmCalls.runId, id)).orderBy(llmCalls.id).all(),
    getRunPhase(env, id),
    d.select().from(contentQueue).where(eq(contentQueue.runId, id)).orderBy(contentQueue.id).all(),
    d.select().from(pipelineIdeas).where(eq(pipelineIdeas.runId, id)).orderBy(pipelineIdeas.id).all(),
  ]);
  return { run: run ?? null, calls, phase, items, ideas };
}

// ── Queue ────────────────────────────────────────────────────────────────────

export interface QueueFilter {
  status?: string;
  category?: string;
  limit?: number;
}

export async function listQueue(
  env: Bindings,
  f: QueueFilter,
): Promise<ContentQueueItem[]> {
  const conds = [];
  if (f.status) conds.push(eq(contentQueue.status, f.status as "pending"));
  if (f.category) conds.push(eq(contentQueue.categorySlug, f.category));
  return db(env.DB)
    .select()
    .from(contentQueue)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(contentQueue.id))
    .limit(f.limit ?? 100)
    .all();
}

const nowIso = () => new Date().toISOString();

// failed/skipped -> pending for the next run; attempts reset so the retry gets
// the full regenerate budget again.
export async function requeueItem(env: Bindings, id: number): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({ status: "pending", attempts: 0, lastError: null, updatedAt: nowIso() })
    .where(eq(contentQueue.id, id));
}

// Bulk re-drive: every failed row back to pending in one action - EXCEPT poison
// rows already attempted >= cap times, which stay failed so a job that keeps
// blowing up cannot loop through bulk retries forever. Unlike requeueItem,
// attempts is deliberately NOT reset: each run increments it (markGenerating),
// so a repeat offender crosses the cap after a few bulk passes and drops out.
// The per-row 'Thu lai' stays the human override that resets the counter.
// A local constant, not cfg.pipeline.maxGenAttempts: that knob caps LLM
// regenerates WITHIN one run; this caps how many runs bulk retry will fund.
export const BULK_RETRY_ATTEMPTS_CAP = 3;

export async function requeueAllFailed(env: Bindings): Promise<{
  requeued: number;
  skippedPoison: number;
  ids: number[];
}> {
  const d = db(env.DB);
  const rows = await d
    .update(contentQueue)
    .set({ status: "pending", lastError: null, updatedAt: nowIso() })
    .where(
      and(
        eq(contentQueue.status, "failed"),
        lt(contentQueue.attempts, BULK_RETRY_ATTEMPTS_CAP),
      ),
    )
    .returning({ id: contentQueue.id });
  const poison = await d
    .select({ n: sql<number>`count(*)` })
    .from(contentQueue)
    .where(
      and(
        eq(contentQueue.status, "failed"),
        gte(contentQueue.attempts, BULK_RETRY_ATTEMPTS_CAP),
      ),
    )
    .get();
  return {
    requeued: rows.length,
    skippedPoison: poison?.n ?? 0,
    ids: rows.map((r) => r.id),
  };
}

export async function skipItem(env: Bindings, id: number): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({ status: "skipped", updatedAt: nowIso() })
    .where(eq(contentQueue.id, id));
}

export async function setPriority(
  env: Bindings,
  id: number,
  priority: number,
): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({ priority, updatedAt: nowIso() })
    .where(eq(contentQueue.id, id));
}

// ── Review (publish.mode = review; items held by B5) ────────────────────────

export async function listReview(env: Bindings): Promise<ContentQueueItem[]> {
  return db(env.DB)
    .select()
    .from(contentQueue)
    .where(eq(contentQueue.status, "awaiting_review"))
    .orderBy(desc(contentQueue.id))
    .all();
}

export async function getQueueItem(
  env: Bindings,
  id: number,
): Promise<ContentQueueItem | null> {
  const row = await db(env.DB)
    .select()
    .from(contentQueue)
    .where(eq(contentQueue.id, id))
    .get();
  return row ?? null;
}

// ── Posts ────────────────────────────────────────────────────────────────────

export interface AdminPostRow {
  id: number;
  slug: string;
  title: string;
  categorySlug: string;
  categoryName: string;
  publishedAt: string;
  isFeatured: number;
  viewCount: number;
  wordCount: number | null;
}

export async function listPosts(env: Bindings, limit = 30): Promise<AdminPostRow[]> {
  return db(env.DB)
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      categorySlug: categories.slug,
      categoryName: categories.name,
      publishedAt: posts.publishedAt,
      isFeatured: posts.isFeatured,
      viewCount: posts.viewCount,
      wordCount: posts.wordCount,
    })
    .from(posts)
    .innerJoin(categories, eq(categories.id, posts.categoryId))
    .orderBy(desc(posts.publishedAt))
    .limit(limit)
    .all();
}

export async function toggleFeatured(env: Bindings, id: number): Promise<void> {
  const d = db(env.DB);
  const row = await d
    .select({ isFeatured: posts.isFeatured })
    .from(posts)
    .where(eq(posts.id, id))
    .get();
  if (!row) return;
  await d
    .update(posts)
    .set({ isFeatured: row.isFeatured ? 0 : 1 })
    .where(eq(posts.id, id));
  const site = siteConfig(env);
  await purgeUrls([absUrl(site, routes.home())]);
}

// Purge one post's URLs (per-PoP Cache API + shared KV payloads).
export async function purgePost(env: Bindings, id: number): Promise<void> {
  const d = db(env.DB);
  const row = await d
    .select({ slug: posts.slug, categorySlug: categories.slug })
    .from(posts)
    .innerJoin(categories, eq(categories.id, posts.categoryId))
    .where(eq(posts.id, id))
    .get();
  if (!row) return;
  const site = siteConfig(env);
  await purgeUrls([
    absUrl(site, routes.post(row.categorySlug, row.slug)),
    absUrl(site, routes.category(row.categorySlug)),
    absUrl(site, routes.home()),
  ]);
  await purgeKvKeys(env, STALE_KV_KEYS);
}

// Purge the whole read side we can reach: KV payloads (global) + the main page
// URLs (Cache API, current PoP only - other PoPs age out by TTL).
export async function purgeSiteCaches(env: Bindings): Promise<number> {
  const d = db(env.DB);
  const cats = await d
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.isActive, 1))
    .all();
  const site = siteConfig(env);
  const urls = [
    absUrl(site, routes.home()),
    absUrl(site, routes.search()),
    absUrl(site, "/feed.xml"),
    absUrl(site, "/sitemap.xml"),
    ...cats.map((c) => absUrl(site, routes.category(c.slug))),
  ];
  await purgeUrls(urls);
  await purgeKvKeys(env, STALE_KV_KEYS);
  return urls.length;
}

// ── LLM calls ────────────────────────────────────────────────────────────────

export interface LlmFilter {
  provider?: string;
  stage?: string;
  ok?: "1" | "0";
  limit?: number;
}

export async function listLlmCalls(env: Bindings, f: LlmFilter): Promise<LlmCall[]> {
  const conds = [];
  if (f.provider) conds.push(eq(llmCalls.provider, f.provider));
  if (f.stage) conds.push(eq(llmCalls.stage, f.stage));
  if (f.ok === "1" || f.ok === "0") conds.push(eq(llmCalls.ok, Number(f.ok)));
  return db(env.DB)
    .select()
    .from(llmCalls)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(llmCalls.id))
    .limit(f.limit ?? 100)
    .all();
}

export interface DailyCost {
  day: string;
  calls: number;
  costMicros: number;
}

export async function dailyLlmCost(env: Bindings, days = 30): Promise<DailyCost[]> {
  return db(env.DB)
    .select({
      day: sql<string>`date(${llmCalls.createdAt} / 1000, 'unixepoch')`,
      calls: sql<number>`count(*)`,
      costMicros: sql<number>`coalesce(sum(${llmCalls.costMicros}), 0)`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.createdAt, Date.now() - days * DAY_MS))
    .groupBy(sql`date(${llmCalls.createdAt} / 1000, 'unixepoch')`)
    .orderBy(desc(sql`date(${llmCalls.createdAt} / 1000, 'unixepoch')`))
    .all();
}

// ── LLM gateway status (provider health, circuit breakers, budget) ──────────
// The read model behind the redesigned /admin/llm console: for each provider we
// resolve its model, position in the failover chain, whether it is configured
// (key/binding present), its circuit-breaker state (from KV cb:<provider>), and
// its 30-day spend. Plus the gateway-wide config + budget-vs-spend.

export type CircuitDisplay = "closed" | "open" | "degraded";

export interface ProviderStatus {
  name: string; // deepseek | workers-ai | openai-compat
  label: string; // display name
  model: string;
  order: number; // index in providerOrder, or -1 if not in the chain
  configured: boolean; // key/binding (and, for openai-compat, baseUrl+model) present
  active: boolean; // in the chain AND configured
  circuitState: CircuitDisplay;
  circuitFails: number;
  openedUntil: number; // epoch ms; 0 = closed
  calls30d: number;
  costMicros30d: number;
}

export interface GatewayStatus {
  providers: ProviderStatus[];
  providerOrder: string[];
  timeoutMs: number;
  maxRetries: number;
  gatewayBinding: string | null; // AI_GATEWAY var ("accountId/gatewayId") or null
  budget: {
    dayCapUsd: number;
    daySpentUsd: number;
    monthCapUsd: number;
    monthSpentUsd: number;
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  "workers-ai": "Workers AI",
  "openai-compat": "OpenAI-compat",
};

const KNOWN_PROVIDERS = ["deepseek", "workers-ai", "openai-compat"];

export async function llmGatewayStatus(env: Bindings): Promise<GatewayStatus> {
  const cfg = await getConfig(env);
  const now = Date.now();
  const [day, month] = await Promise.all([
    llmStats(env, now - DAY_MS),
    llmStats(env, now - 30 * DAY_MS),
  ]);

  const providers = await Promise.all(
    KNOWN_PROVIDERS.map(async (name): Promise<ProviderStatus> => {
      const order = cfg.llm.providerOrder.indexOf(name);
      let configured = false;
      let model = "";
      if (name === "deepseek") {
        configured = !!env.DEEPSEEK_API_KEY;
        model = cfg.llm.models.deepseek;
      } else if (name === "workers-ai") {
        configured = !!env.AI;
        model = cfg.llm.models.workersAi;
      } else {
        configured =
          !!env.OPENAI_COMPAT_API_KEY &&
          !!cfg.llm.openaiCompat.baseUrl &&
          !!cfg.llm.openaiCompat.model;
        model = cfg.llm.openaiCompat.model || "-";
      }
      const cb = await readCircuit(env, name).catch(() => CB_CLOSED);
      const circuitState: CircuitDisplay = isCircuitOpen(cb, now)
        ? "open"
        : cb.fails > 0
          ? "degraded"
          : "closed";
      const stat = month.byProvider[name] ?? { calls: 0, costMicros: 0 };
      return {
        name,
        label: PROVIDER_LABELS[name] ?? name,
        model,
        order,
        configured,
        active: order >= 0 && configured,
        circuitState,
        circuitFails: cb.fails,
        openedUntil: cb.openedUntil,
        calls30d: stat.calls,
        costMicros30d: stat.costMicros,
      };
    }),
  );

  // Active providers first (by failover order), then configured-but-off, then
  // the rest.
  const rank = (p: ProviderStatus) => (p.active ? p.order : p.configured ? 50 : 99);
  providers.sort((a, b) => rank(a) - rank(b));

  return {
    providers,
    providerOrder: cfg.llm.providerOrder,
    timeoutMs: cfg.llm.timeoutMs,
    maxRetries: cfg.llm.maxRetries,
    gatewayBinding: (env.AI_GATEWAY ?? "").trim() || null,
    budget: {
      dayCapUsd: cfg.llm.dailyBudgetUsd,
      daySpentUsd: day.costMicros / 1e6,
      monthCapUsd: cfg.llm.monthlyBudgetUsd,
      monthSpentUsd: month.costMicros / 1e6,
    },
  };
}

// ── Notifications (topbar bell + /admin/alerts) ─────────────────────────────

export async function unreadNotificationCount(env: Bindings): Promise<number> {
  const row = await db(env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(isNull(notifications.readAt))
    .get();
  return row?.n ?? 0;
}

export async function listNotifications(env: Bindings, limit = 50): Promise<Notification[]> {
  return db(env.DB)
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .all();
}

// Mark one notification read, or all unread when id is omitted.
export async function markNotificationsRead(env: Bindings, id?: number): Promise<void> {
  const now = Date.now();
  const q = db(env.DB).update(notifications).set({ readAt: now });
  await (id != null
    ? q.where(eq(notifications.id, id))
    : q.where(isNull(notifications.readAt)));
}

// ── Config audit ─────────────────────────────────────────────────────────────

export async function listConfigAudit(env: Bindings, limit = 20) {
  return db(env.DB)
    .select()
    .from(configAudit)
    .orderBy(desc(configAudit.id))
    .limit(limit)
    .all();
}

// ── Config form parsing (server-side validation, no client JS) ──────────────

export interface ConfigFormResult {
  patch: DeepPartial<RuntimeConfig>;
  errors: string[];
}

// Each field: [form name, min, max, integer?]
const NUM_FIELDS: [string, number, number, boolean][] = [
  ["pipeline.postsPerDay", 1, 10, true],
  ["pipeline.backfillCount", 1, 60, true],
  ["pipeline.maxGenAttempts", 1, 5, true],
  ["pipeline.timeBudgetMs", 5_000, 300_000, true],
  ["quality.minWords", 200, 2_000, true],
  ["quality.similarityThreshold", 0, 1, false],
  ["quality.criticMinScore", 1, 10, true],
  ["llm.timeoutMs", 10_000, 300_000, true],
  ["llm.maxRetries", 0, 5, true],
  ["llm.dailyBudgetUsd", 0, 100, false],
  ["llm.monthlyBudgetUsd", 0, 1_000, false],
  ["alerts.failRateThreshold", 0, 1, false],
  ["alerts.staleRunHours", 1, 168, true],
  ["safety.softThreshold", 0, 20, true],
];

const BOOL_FIELDS = [
  "pipeline.enabled",
  "quality.criticEnabled",
  "alerts.enabled",
  "safety.enabled",
];

// Free-text list fields: split on commas/newlines into a trimmed string[].
const LIST_FIELDS = [
  "safety.extraHardTerms",
  "safety.extraSoftTerms",
  "safety.allowPhrases",
];

export function parseConfigForm(form: FormData): ConfigFormResult {
  const patch: Record<string, unknown> = {};
  const errors: string[] = [];

  const setPath = (dotted: string, value: unknown) => {
    const keys = dotted.split(".");
    let node = patch;
    for (let i = 0; i < keys.length - 1; i++) {
      node = (node[keys[i]] ??= {}) as Record<string, unknown>;
    }
    node[keys[keys.length - 1]] = value;
  };

  for (const [name, min, max, integer] of NUM_FIELDS) {
    const raw = form.get(name);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      errors.push(`${name}: can so ${integer ? "nguyen " : ""}trong [${min}, ${max}]`);
      continue;
    }
    setPath(name, n);
  }

  // Checkboxes: the form posts "on" when checked; absent means false. A hidden
  // marker field (present on every submit) tells us the form included them.
  for (const name of BOOL_FIELDS) {
    setPath(name, form.get(name) === "on");
  }

  for (const name of LIST_FIELDS) {
    const raw = form.get(name);
    if (raw === null) continue;
    const arr = String(raw)
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setPath(name, arr);
  }

  // Editable prompt layers (free text). Stored verbatim; a blank value is fine -
  // articlePrompt falls back to the code default when an override is blank.
  for (const name of ["prompts.houseVoice", "prompts.toneCard"]) {
    const raw = form.get(name);
    if (raw === null) continue;
    setPath(name, String(raw));
  }
  // Per-author voice seeds arrive as prompts.personas.<slug> fields.
  for (const [key, val] of form.entries()) {
    if (key.startsWith("prompts.personas.")) setPath(key, String(val));
  }

  const mode = form.get("publish.mode");
  if (mode === "auto" || mode === "review") setPath("publish.mode", mode);
  else if (mode !== null) errors.push("publish.mode: auto hoac review");

  const channels: string[] = [];
  if (form.get("alerts.channel.email") === "on") channels.push("email");
  if (form.get("alerts.channel.telegram") === "on") channels.push("telegram");
  setPath("alerts.channels", channels);

  return { patch: patch as DeepPartial<RuntimeConfig>, errors };
}
