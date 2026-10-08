// Daily ops heartbeat: one Telegram digest that ALWAYS fires (not error-gated,
// not deduped), so "no news" stops being ambiguous - a green digest every night
// means the whole pipeline is alive, and a MISSING digest is itself the signal
// that the cron has stopped firing entirely (the one failure the Worker cannot
// self-detect; see docs/ops-runbook.md).
//
// It rolls up every subsystem into a single message, INCLUDING the ones that are
// otherwise silent when they degrade.
//
// Split into gatherHealth (bindings + DB) and formatDigest (pure) so the status
// logic and message shape are unit-tested without a live environment.

import { gte, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { db } from "../db/client";
import { posts } from "../db/schema";
import { getConfig } from "../lib/runtime-config";
import { log } from "../lib/log";
import { sendTelegram } from "../lib/alerts";
import { queueStats } from "./queue";
import { llmStats, lastGoodRun, runsSince, recordNotification } from "./telemetry";
import { readCircuit } from "./llm";
import { isCircuitOpen } from "./llm-policy";

export type HealthStatus = "OK" | "WARN" | "DOWN";

const DAY_MS = 24 * 60 * 60_000;

// Normalized health snapshot. All threshold decisions that need runtime config
// are resolved here (into plain booleans/numbers) so formatDigest stays pure.
export interface HealthData {
  checks: { db: boolean; kv: boolean; r2: boolean };
  runs24h: { total: number; cron: number; published: number; failed: number; anyFailed: boolean };
  lastGoodAgeH: number | null;
  stale: boolean; // no good run within cfg.alerts.staleRunHours
  posts: { total: number; last24h: number };
  queue: { pending: number; failed: number; published: number };
  llm: { calls24h: number; cost24h: number; costMtd: number; monthlyBudget: number };
  openProviders: string[];
  config: { pipelineEnabled: boolean; postsPerDay: number; publishMode: string; channels: string[] };
}

async function probe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

export async function gatherHealth(env: Bindings): Promise<HealthData> {
  const now = Date.now();
  const cfg = await getConfig(env);

  const [dbOk, kvOk, r2Ok] = await Promise.all([
    probe(() => db(env.DB).select({ n: sql<number>`1` }).from(posts).limit(1).get()),
    probe(() => env.CACHE_KV.get("cfg:v1")),
    probe(() => env.UPLOADS.list({ limit: 1 })),
  ]);

  const since24 = now - DAY_MS;
  const since24Iso = new Date(since24).toISOString();
  const monthStart = (() => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  })();

  const [runs, good, totalRow, pub24Row, queue, llm24, llmMtd] = await Promise.all([
    runsSince(env, since24).catch(() => []),
    lastGoodRun(env).catch(() => null),
    db(env.DB).select({ n: sql<number>`count(*)` }).from(posts).get().catch(() => ({ n: 0 })),
    db(env.DB)
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(gte(posts.publishedAt, since24Iso))
      .get()
      .catch(() => ({ n: 0 })),
    queueStats(env).catch(() => ({ byStatus: {} as Record<string, number>, pendingByCategory: {} })),
    llmStats(env, since24).catch(() => null),
    llmStats(env, monthStart).catch(() => null),
  ]);

  const runs24h = {
    total: runs.length,
    cron: runs.filter((r) => r.trigger === "cron").length,
    published: runs.reduce((s, r) => s + (r.published ?? 0), 0),
    failed: runs.reduce((s, r) => s + (r.failed ?? 0), 0),
    anyFailed: runs.some((r) => r.status === "failed"),
  };

  const lastGoodAgeH = good ? +((now - good.startedAt) / 3_600_000).toFixed(1) : null;
  const stale = lastGoodAgeH == null || lastGoodAgeH > cfg.alerts.staleRunHours;

  // Circuit-breaker state per configured provider.
  const openProviders: string[] = [];
  for (const p of cfg.llm.providerOrder) {
    try {
      if (isCircuitOpen(await readCircuit(env, p), now)) openProviders.push(p);
    } catch {
      /* a CB read failure is not itself a provider outage */
    }
  }

  return {
    checks: { db: dbOk, kv: kvOk, r2: r2Ok },
    runs24h,
    lastGoodAgeH,
    stale,
    posts: { total: totalRow?.n ?? 0, last24h: pub24Row?.n ?? 0 },
    queue: {
      pending: queue.byStatus.pending ?? 0,
      failed: queue.byStatus.failed ?? 0,
      published: queue.byStatus.published ?? 0,
    },
    llm: {
      calls24h: llm24?.calls ?? 0,
      cost24h: +((llm24?.costMicros ?? 0) / 1e6).toFixed(4),
      costMtd: +((llmMtd?.costMicros ?? 0) / 1e6).toFixed(2),
      monthlyBudget: cfg.llm.monthlyBudgetUsd,
    },
    openProviders,
    config: {
      pipelineEnabled: cfg.pipeline.enabled,
      postsPerDay: cfg.pipeline.postsPerDay,
      publishMode: cfg.publish.mode,
      channels: cfg.alerts.channels,
    },
  };
}

// Pure: derive the overall status + the human digest text from a HealthData.
export function formatDigest(d: HealthData, siteName = "Edge Magazine"): { status: HealthStatus; text: string } {
  const infraOk = d.checks.db && d.checks.kv && d.checks.r2;
  const overBudget = d.llm.monthlyBudget > 0 && d.llm.costMtd > d.llm.monthlyBudget;
  // Below-target (not just zero): a day where dedup/safety empties most slots
  // publishes 1-of-3 without any run failing - that gap must surface here.
  const belowTarget =
    d.config.publishMode === "auto" &&
    d.config.postsPerDay > 0 &&
    d.posts.last24h < d.config.postsPerDay;
  const queueStuck = d.queue.pending >= 5;

  let status: HealthStatus = "OK";
  if (!infraOk || d.stale) {
    status = "DOWN";
  } else if (
    d.runs24h.anyFailed ||
    d.openProviders.length > 0 ||
    overBudget ||
    !d.config.pipelineEnabled ||
    belowTarget ||
    queueStuck
  ) {
    status = "WARN";
  }

  const chk = (ok: boolean) => (ok ? "ok" : "FAIL");
  const providerLine = d.openProviders.length
    ? `Providers: circuit OPEN - ${d.openProviders.join(", ")}`
    : "Providers: all OK";
  const lastGoodLine =
    d.lastGoodAgeH == null
      ? "Last good run: NONE"
      : `Last good run: ${d.lastGoodAgeH}h ago${d.stale ? " (STALE)" : ""}`;

  const lines = [
    `[${siteName}] System health: ${status}`,
    "",
    `Cron 24h: ${d.runs24h.cron} runs, published ${d.runs24h.published}, failed ${d.runs24h.failed}`,
    `Posts: ${d.posts.total} total, +${d.posts.last24h} in 24h / target ${d.config.postsPerDay}${belowTarget ? " (BELOW TARGET)" : ""}`,
    `Queue: ${d.queue.pending} pending, ${d.queue.failed} failed (cumulative)`,
    `LLM: ${d.llm.calls24h} calls, $${d.llm.cost24h} / 24h | month $${d.llm.costMtd} / $${d.llm.monthlyBudget}`,
    providerLine,
    `Infra: DB ${chk(d.checks.db)}, KV ${chk(d.checks.kv)}, R2 ${chk(d.checks.r2)}`,
    lastGoodLine,
    `Config: pipeline ${d.config.pipelineEnabled ? "ON" : "OFF"}, ${d.config.postsPerDay} posts/day, ${d.config.publishMode}, channels: ${d.config.channels.join("+") || "(none)"}`,
  ];
  return { status, text: lines.join("\n") };
}

// Build + send the daily digest to Telegram and mirror it into the in-app feed.
// Best-effort: never throws (the cron wraps it, but be defensive anyway).
export async function sendHeartbeat(env: Bindings): Promise<{ status: HealthStatus; telegram: string; text: string }> {
  const data = await gatherHealth(env);
  const { status, text } = formatDigest(data, env.SITE_NAME || "Edge Magazine");

  const telegram = await sendTelegram(env, text);
  await recordNotification(env, {
    kind: "heartbeat",
    severity: status === "DOWN" ? "error" : status === "WARN" ? "warn" : "info",
    title: `System health: ${status}`,
    body: text,
    href: "/admin/tools",
  });
  log.info("heartbeat.sent", { status, telegram });
  return { status, telegram, text };
}
