// Pipeline telemetry: persist what each run did (pipeline_runs), every LLM call
// it made (llm_calls), reclaim items a crash left mid-flight, and assemble the
// deep health report. All writes are best-effort - a telemetry failure logs and
// returns, never breaking generation.

import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { contentQueue, llmCalls, notifications, pipelineIdeas, pipelineRuns } from "../db/schema";
import type { PipelineIdea, PipelineRun } from "../db/schema";
import type { Bindings } from "../env";
import type { ModelPricing } from "../lib/runtime-config";
import { configSource, getConfig } from "../lib/runtime-config";
import { log, errStr } from "../lib/log";
import { queueStats } from "./queue";
import type { RunReport } from "./generate";

export type RunTrigger = "cron" | "manual" | "backfill";
export type RunStatus = "running" | "ok" | "partial" | "failed" | "skipped";

// Insert a 'running' row up-front so a hung/crashed run is visible (and the
// watchdog can find it). Returns the id + start time to pass back to finishRun.
export async function startRun(
  env: Bindings,
  trigger: RunTrigger,
): Promise<{ runId: string; startedAt: number }> {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    await db(env.DB)
      .insert(pipelineRuns)
      .values({ id: runId, trigger, status: "running", startedAt });
    log.info("run.start", { runId, trigger });
  } catch (e) {
    log.warn("run.start_persist_failed", { runId, err: errStr(e) });
  }
  return { runId, startedAt };
}

export async function finishRun(
  env: Bindings,
  args: {
    runId: string;
    startedAt: number;
    status: RunStatus;
    report?: RunReport;
    error?: string;
  },
): Promise<void> {
  const finishedAt = Date.now();
  const r = args.report;
  try {
    await db(env.DB)
      .update(pipelineRuns)
      .set({
        status: args.status,
        finishedAt,
        durationMs: finishedAt - args.startedAt,
        requested: r?.requested ?? null,
        ideated: r?.ideated ?? null,
        enqueued: r?.enqueued ?? null,
        skippedDup: r?.skippedDuplicates ?? null,
        published: r?.published.length ?? null,
        failed: r?.failed.length ?? null,
        reportJson: r ? JSON.stringify(r) : null,
        error: args.error ?? null,
      })
      .where(eq(pipelineRuns.id, args.runId));
  } catch (e) {
    log.warn("run.finish_persist_failed", { runId: args.runId, err: errStr(e) });
  }
  // The run is over - drop the live phase heartbeat.
  await clearRunPhase(env, args.runId);
}

// A no-op run (kill switch off) still leaves a row so the dashboard shows "we
// were asked to run at 08:00 but the pipeline was disabled".
export async function recordSkippedRun(
  env: Bindings,
  trigger: RunTrigger,
): Promise<void> {
  const now = Date.now();
  try {
    await db(env.DB).insert(pipelineRuns).values({
      id: crypto.randomUUID(),
      trigger,
      status: "skipped",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
    });
  } catch (e) {
    log.warn("run.skip_persist_failed", { err: errStr(e) });
  }
}

export interface LlmCallInput {
  runId?: string;
  queueId?: number;
  stage: string;
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  attempt: number;
  pricing?: Record<string, ModelPricing>;
}

// cost in USD-micros (USD * 1e6). inPerM/outPerM are USD per 1e6 tokens, so
// micros = prompt*inPerM + completion*outPerM. Unknown model -> 0.
function costMicros(input: LlmCallInput): number {
  const p = input.pricing?.[input.model];
  if (!p) return 0;
  return Math.round(
    (input.promptTokens ?? 0) * p.inPerM + (input.completionTokens ?? 0) * p.outPerM,
  );
}

export async function recordLlmCall(
  env: Bindings,
  input: LlmCallInput,
): Promise<void> {
  try {
    await db(env.DB).insert(llmCalls).values({
      runId: input.runId ?? null,
      queueId: input.queueId ?? null,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      ok: input.ok ? 1 : 0,
      error: input.error ? input.error.slice(0, 300) : null,
      latencyMs: input.latencyMs,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      costMicros: costMicros(input),
      attempt: input.attempt,
      createdAt: Date.now(),
    });
  } catch (e) {
    log.warn("llm.call_persist_failed", { err: errStr(e) });
  }
}

// Items left 'generating' by a crashed/timed-out run go back to 'pending' so the
// next run retries them. attempts is preserved (it already counted the try).
export async function reclaimStuck(
  env: Bindings,
  olderThanMs = 15 * 60_000,
): Promise<number> {
  const d = db(env.DB);
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stuck = await d
    .select({ id: contentQueue.id })
    .from(contentQueue)
    .where(
      and(
        eq(contentQueue.status, "generating"),
        isNotNull(contentQueue.updatedAt),
        lt(contentQueue.updatedAt, cutoff),
      ),
    )
    .all();
  if (!stuck.length) return 0;
  const ids = stuck.map((r) => r.id);
  await d
    .update(contentQueue)
    .set({ status: "pending", updatedAt: new Date().toISOString() })
    .where(inArray(contentQueue.id, ids));
  log.warn("queue.reclaim", { count: ids.length, ids });
  return ids.length;
}

// Manual reclaim of ONE run: force-fail it if still 'running' and return the
// items it left in 'generating' to 'pending'. Returns how many items were freed.
// Exposed on the admin run page so a stuck run does not have to wait for the
// 15-min reclaimStuck / 2-hr hung-run watchdog.
export async function reclaimRun(env: Bindings, runId: string): Promise<number> {
  const now = Date.now();
  try {
    await db(env.DB)
      .update(pipelineRuns)
      .set({ status: "failed", finishedAt: now, error: "thu hoi thu cong (manual reclaim)" })
      .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.status, "running")));
  } catch (e) {
    log.warn("run.reclaim_run_failed", { runId, err: errStr(e) });
  }
  let n = 0;
  try {
    const stuck = await db(env.DB)
      .select({ id: contentQueue.id })
      .from(contentQueue)
      .where(and(eq(contentQueue.runId, runId), eq(contentQueue.status, "generating")))
      .all();
    if (stuck.length) {
      const ids = stuck.map((r) => r.id);
      await db(env.DB)
        .update(contentQueue)
        .set({ status: "pending", updatedAt: new Date().toISOString() })
        .where(inArray(contentQueue.id, ids));
      n = ids.length;
    }
  } catch (e) {
    log.warn("run.reclaim_items_failed", { runId, err: errStr(e) });
  }
  await clearRunPhase(env, runId);
  return n;
}

// ── Pipeline ideas (planning-stage audit) ───────────────────────────────────
// Persist every ideated topic and its fate (enqueued / dup / safety_blocked /
// unused). Best-effort like the rest of telemetry - a failure never breaks a run.
export type NewIdea = typeof pipelineIdeas.$inferInsert;

export async function recordIdeas(env: Bindings, rows: NewIdea[]): Promise<void> {
  if (!rows.length) return;
  try {
    // Chunk to stay well under D1's bound-parameter ceiling on big batches.
    for (let i = 0; i < rows.length; i += 40) {
      await db(env.DB).insert(pipelineIdeas).values(rows.slice(i, i + 40));
    }
  } catch (e) {
    log.warn("ideas.persist_failed", { err: errStr(e) });
  }
}

export async function ideasForRun(env: Bindings, runId: string): Promise<PipelineIdea[]> {
  return db(env.DB)
    .select()
    .from(pipelineIdeas)
    .where(eq(pipelineIdeas.runId, runId))
    .orderBy(pipelineIdeas.id)
    .all();
}

// ── Notifications (in-app ops feed for the topbar bell + /admin/alerts) ──────
export interface NotificationInput {
  kind: string;
  severity: "info" | "warn" | "error";
  title: string;
  body?: string;
  href?: string;
}

// Persist a notification. Best-effort: sendAlert calls this alongside the
// email/telegram channels, so a DB hiccup never blocks an alert being sent.
export async function recordNotification(env: Bindings, n: NotificationInput): Promise<void> {
  try {
    await db(env.DB).insert(notifications).values({
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body ?? null,
      href: n.href ?? null,
      createdAt: Date.now(),
    });
  } catch (e) {
    log.warn("notif.persist_failed", { err: errStr(e) });
  }
}

// ── Run phase heartbeat (live progress for the run detail page) ─────────────
// The non-LLM stages (ideation aside, they are: fetching a photo, publishing)
// emit no llm_calls, so a run can look frozen while it is actually working. Each
// stage writes a coarse phase to KV as a heartbeat; the run detail reads it to
// show "where it is right now" + how long it has sat there (stall detection).
// Best-effort: a KV hiccup never breaks generation.
export interface RunPhase {
  phase: string; // machine key: ideation | generating | publishing
  detail?: string; // e.g. the topic being worked
  at: number; // epoch ms of the last update
}
const PHASE_TTL_SECONDS = 3600;

export async function setRunPhase(
  env: Bindings,
  runId: string,
  phase: string,
  detail?: string,
): Promise<void> {
  try {
    await env.CACHE_KV.put(
      `run:${runId}:phase`,
      JSON.stringify({ phase, detail, at: Date.now() } satisfies RunPhase),
      { expirationTtl: PHASE_TTL_SECONDS },
    );
  } catch (e) {
    log.warn("run.phase_write_failed", { runId, err: errStr(e) });
  }
}

export async function getRunPhase(env: Bindings, runId: string): Promise<RunPhase | null> {
  try {
    const raw = await env.CACHE_KV.get(`run:${runId}:phase`);
    return raw ? (JSON.parse(raw) as RunPhase) : null;
  } catch {
    return null;
  }
}

async function clearRunPhase(env: Bindings, runId: string): Promise<void> {
  try {
    await env.CACHE_KV.delete(`run:${runId}:phase`);
  } catch {
    /* best-effort */
  }
}

// ── Read helpers (watchdog + health + dashboard) ────────────────────────────

export async function lastRun(env: Bindings): Promise<PipelineRun | null> {
  const row = await db(env.DB)
    .select()
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(1)
    .get();
  return row ?? null;
}

// All runs started within the window (newest first). Powers the health-digest
// 24h rollup (how many cron/manual runs, how much published/failed).
export async function runsSince(env: Bindings, sinceMs: number): Promise<PipelineRun[]> {
  return db(env.DB)
    .select()
    .from(pipelineRuns)
    .where(gte(pipelineRuns.startedAt, sinceMs))
    .orderBy(desc(pipelineRuns.startedAt))
    .all();
}

// Most recent run that actually produced content (ok or partial).
export async function lastGoodRun(env: Bindings): Promise<PipelineRun | null> {
  const row = await db(env.DB)
    .select()
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.status, ["ok", "partial"]))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(1)
    .get();
  return row ?? null;
}

// Runs still 'running' that started before the cutoff = hung (a crash before
// finishRun). The watchdog unsticks and alerts on these.
export async function hungRuns(
  env: Bindings,
  olderThanMs = 2 * 60 * 60_000,
): Promise<PipelineRun[]> {
  return db(env.DB)
    .select()
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.status, "running"),
        lt(pipelineRuns.startedAt, Date.now() - olderThanMs),
      ),
    )
    .all();
}

export async function markRunFailed(
  env: Bindings,
  runId: string,
  error: string,
): Promise<void> {
  const finishedAt = Date.now();
  await db(env.DB)
    .update(pipelineRuns)
    .set({ status: "failed", finishedAt, error })
    .where(eq(pipelineRuns.id, runId));
}

// Calls + cost + token usage for a slice of llm_calls. Tokens were always stored
// per call; this rolls them up so the dashboard can show "total tokens" and a
// per-stage / per-provider breakdown (ideation vs draft vs critic - the real
// lever for tuning spend).
export interface LlmUsage {
  calls: number;
  costMicros: number;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmStats extends LlmUsage {
  byProvider: Record<string, LlmUsage>;
  byStage: Record<string, LlmUsage>;
}

export async function llmStats(env: Bindings, sinceMs: number): Promise<LlmStats> {
  const d = db(env.DB);
  const cols = {
    calls: sql<number>`count(*)`,
    cost: sql<number>`coalesce(sum(${llmCalls.costMicros}), 0)`,
    pt: sql<number>`coalesce(sum(${llmCalls.promptTokens}), 0)`,
    ct: sql<number>`coalesce(sum(${llmCalls.completionTokens}), 0)`,
  };
  const since = gte(llmCalls.createdAt, sinceMs);
  const [byProv, byStg] = await Promise.all([
    d.select({ k: llmCalls.provider, ...cols }).from(llmCalls).where(since).groupBy(llmCalls.provider).all(),
    d.select({ k: llmCalls.stage, ...cols }).from(llmCalls).where(since).groupBy(llmCalls.stage).all(),
  ]);
  const row = (r: { calls: number; cost: number; pt: number; ct: number }): LlmUsage => ({
    calls: r.calls,
    costMicros: r.cost,
    promptTokens: r.pt,
    completionTokens: r.ct,
  });
  const out: LlmStats = {
    calls: 0,
    costMicros: 0,
    promptTokens: 0,
    completionTokens: 0,
    byProvider: {},
    byStage: {},
  };
  // Each call has exactly one provider, so summing the provider groups yields the
  // grand totals; the stage groups are the same rows re-bucketed.
  for (const r of byProv) {
    out.calls += r.calls;
    out.costMicros += r.cost;
    out.promptTokens += r.pt;
    out.completionTokens += r.ct;
    out.byProvider[r.k] = row(r);
  }
  for (const r of byStg) out.byStage[r.k] = row(r);
  return out;
}

// Total tokens (prompt + completion) for a usage bucket.
export function totalTokens(u: { promptTokens: number; completionTokens: number }): number {
  return u.promptTokens + u.completionTokens;
}

// ── Deep health report (GET /api/health) ────────────────────────────────────

export async function healthReport(env: Bindings): Promise<Record<string, unknown>> {
  const checks = { db: false, kv: false, r2: false };

  try {
    await env.DB.prepare("SELECT 1").first();
    checks.db = true;
  } catch (e) {
    log.warn("health.db_failed", { err: errStr(e) });
  }
  try {
    const probe = String(Date.now());
    await env.CACHE_KV.put("health:probe", probe, { expirationTtl: 60 });
    checks.kv = (await env.CACHE_KV.get("health:probe")) === probe;
  } catch (e) {
    log.warn("health.kv_failed", { err: errStr(e) });
  }
  try {
    await env.UPLOADS.list({ limit: 1 });
    checks.r2 = true;
  } catch (e) {
    log.warn("health.r2_failed", { err: errStr(e) });
  }

  const [queue, run, llm24h, cfg, source] = await Promise.all([
    queueStats(env).catch(() => ({ byStatus: {}, pendingByCategory: {} })),
    lastRun(env).catch(() => null),
    llmStats(env, Date.now() - 24 * 60 * 60_000).catch(() => null),
    getConfig(env),
    configSource(env),
  ]);

  const ok = checks.db && checks.kv && checks.r2;
  return {
    ok,
    checks,
    queue,
    lastRun: run
      ? {
          id: run.id,
          trigger: run.trigger,
          status: run.status,
          startedAt: new Date(run.startedAt).toISOString(),
          ageMinutes: Math.round((Date.now() - run.startedAt) / 60_000),
          published: run.published,
          failed: run.failed,
        }
      : null,
    llm24h: llm24h
      ? {
          calls: llm24h.calls,
          costUsd: +(llm24h.costMicros / 1e6).toFixed(4),
          byProvider: llm24h.byProvider,
        }
      : null,
    config: {
      source,
      pipelineEnabled: cfg.pipeline.enabled,
      postsPerDay: cfg.pipeline.postsPerDay,
      publishMode: cfg.publish.mode,
    },
  };
}
