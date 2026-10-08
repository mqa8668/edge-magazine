// The orchestrator. One run: read coverage -> plan a balanced, style-rotated
// batch -> ideate topics per category (dedup) -> enqueue -> for each: generate
// (LLM + validate + regenerate), fetch a real photo, publish. Called by the Cron
// (daily) and by POST /api/run (manual, e.g. the staging voice-check backfill).

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { categories, contentQueue, posts, type ContentQueueItem } from "../db/schema";
import type { Bindings, GenerateJob } from "../env";
import { publishPost } from "../api/publish";
import { cleanText } from "../lib/sanitize";
import { stripHtml } from "../lib/html";
import { foldAscii, isValidSlug, slugify } from "../lib/slug";
import { BudgetExceededError, chat, parseJsonObject } from "./llm";
import { planBatch, type StyleAssignment } from "./rotation";
import {
  criticPrompt,
  endingPrompt,
  expandSectionPrompt,
  ideationPrompt,
  leadPrompt,
  outlinePrompt,
  patchPartPrompt,
  patchTitlePrompt,
  planArticle,
  sectionPrompt,
  type Outline,
  type PromptOverrides,
} from "./prompts";
import {
  isRepairable,
  reconcileMetaTitle,
  validateDraft,
  type Draft,
  type Issue,
  type Verdict,
} from "./validate";
import { addInternalLinks } from "./internal-links";
import { assignCluster } from "./clusters";
import { getGscDemandByCategory, mergeDemand } from "./gsc";
import { containment, jaccard, normalizeTopic } from "./normalize";
import { submitIndexNow } from "../seo/indexnow";
import { faqPage } from "../seo/structured-data";
import { absUrl, routes, siteConfig } from "../lib/config";
import { checkSafety, hasHardHit, type SafetyConfig } from "./safety";
import { niche } from "./niche";
import { downloadImage, extForContentType, fetchPhoto } from "./photos";
import {
  enqueueTopics,
  markAwaitingReview,
  markFailed,
  markGenerating,
  markPublished,
  popPending,
  usedPhotoIds,
  type EnqueueOutcome,
  type SlotStyle,
  type TopicCandidate,
} from "./queue";
import {
  finishRun,
  recordIdeas,
  reclaimStuck,
  setRunPhase,
  startRun,
  type NewIdea,
  type RunStatus,
  type RunTrigger,
} from "./telemetry";
import { getTagVocabulary } from "../db/queries";
import { getConfig, type RuntimeConfig } from "../lib/runtime-config";
import { maybeAlertOnRun } from "../lib/alerts";
import { log, errStr } from "../lib/log";

const DEFAULT_MAX_GEN_ATTEMPTS = 3;

// Extra ideation rounds when dedup/safety empties a batch slot (planAndEnqueue
// step 6). Two is enough to ride out a saturated demand pool without letting a
// pathological run burn LLM budget on ideation forever.
const BACKFILL_ROUNDS = 2;

export interface RunOptions {
  count: number; // how many articles to produce
  backdateDays?: number; // spread publishedAt back over this many days (backfill)
  temperature?: number;
  trigger?: RunTrigger; // provenance for pipeline_runs (default "manual")
  config?: RuntimeConfig; // pass to avoid a redundant KV read; else fetched
  // Reuse a run row already opened by the caller (the admin route opens it up
  // front so it can redirect to the run page, then the queue consumer runs the
  // batch). When set, runBatch skips startRun.
  preStarted?: { runId: string; startedAt: number };
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  requested: number;
  ideated: number;
  enqueued: number;
  skippedDuplicates: number;
  published: { slug: string; title: string; category: string; photo: string }[];
  failed: { topic: string; error: string }[];
  held: { topic: string; category: string }[]; // review mode: awaiting admin
  timedOut?: boolean; // run stopped early on the time budget (status "partial")
}

export async function runBatch(
  env: Bindings,
  opts: RunOptions,
): Promise<RunReport> {
  const cfg = opts.config ?? (await getConfig(env));
  const trigger = opts.trigger ?? "manual";
  const { runId, startedAt } = opts.preStarted ?? (await startRun(env, trigger));
  const report: RunReport = {
    runId,
    status: "running",
    requested: opts.count,
    ideated: 0,
    enqueued: 0,
    skippedDuplicates: 0,
    published: [],
    failed: [],
    held: [],
  };

  try {
    // Return items a previous crashed/timed-out run left mid-flight to the queue.
    await reclaimStuck(env);
    await produce(env, cfg, opts, runId, startedAt, report);

    const produced = report.published.length + report.held.length;
    report.status = report.failed.length && !produced
      ? "failed"
      : report.timedOut
        ? "partial"
        : "ok";
    await finishRun(env, { runId, startedAt, status: report.status, report });
    if (trigger === "cron") await maybeAlertOnRun(env, cfg, report);
    return report;
  } catch (err) {
    report.status = "failed";
    await finishRun(env, {
      runId,
      startedAt,
      status: "failed",
      report,
      error: errStr(err),
    });
    // Crash alerts are raised by the cron caller (scheduled); manual callers log.
    throw err;
  }
}

// Plan a balanced, style-rotated batch, ideate topics per category (dedup), and
// enqueue the survivors. This is the fast, LLM-ideation half of a run. Shared by
// the inline producer (produce, below) AND the daily cron fan-out (src/index.ts),
// which enqueues the resulting pending items to the queue - one job per item -
// instead of producing them inline under a single time budget. Updates the run
// report's ideated/enqueued/skippedDuplicates counters and returns the category
// display-name map so the caller can label produced items.
export async function planAndEnqueue(
  env: Bindings,
  cfg: RuntimeConfig,
  count: number,
  runId: string,
  report: RunReport,
): Promise<Map<string, string>> {
  const d = db(env.DB);

  // 1. Active categories + coverage.
  const cats = await d
    .select({
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      count: categories.postCount,
    })
    .from(categories)
    .where(eq(categories.isActive, 1))
    .orderBy(categories.position)
    .all();
  if (!cats.length) throw new Error("no active categories");
  const nameBySlug = new Map(cats.map((c) => [c.slug, c.name]));
  const descBySlug = new Map(cats.map((c) => [c.slug, c.description ?? ""]));
  const coverage: Record<string, number> = {};
  for (const c of cats) coverage[c.slug] = c.count;
  const catSlugs = cats.map((c) => c.slug);

  // 2. Plan the balanced, style-rotated batch.
  const assignments = planBatch({ categories: catSlugs, coverage, count });

  // 3. Ideate topics per category (a couple extra to survive dedup).
  await setRunPhase(env, runId, "ideation", "Brainstorming topics");
  const covered = await coveredTopics(d);
  const byCat = new Map<string, StyleAssignment[]>();
  for (const a of assignments) {
    const list = byCat.get(a.categorySlug) ?? [];
    list.push(a);
    byCat.set(a.categorySlug, list);
  }

  // Proven-demand queries from Google Search Console, keyed by category. Fetched
  // once per run (KV-cached), used per category
  // below. Empty until the property has data - harmless, ideation then falls
  // back to LLM free-choice.
  const gscByCat = await getGscDemandByCategory(env, cfg, new Set(catSlugs)).catch(
    () => new Map<string, string[]>(),
  );

  const candidates: TopicCandidate[] = [];
  const slots = new Map<string, SlotStyle[]>();
  // Per-idea audit rows (pipeline_ideas): safety-blocked are known now;
  // enqueued/dup/unused are filled in from the enqueue outcomes below.
  const ideaRows: NewIdea[] = [];
  const ideatedAt = Date.now();

  // Everything proposed this run, feeding the backfill rounds (step 6): topics
  // go to the FRONT of the retry prompt's avoid list (the prompt truncates the
  // tail), keywords are screened out of the retry demand pool so the LLM cannot
  // re-anchor to a query that just deduped.
  const triedByCat = new Map<string, string[]>();
  const triedKeywords = new Set<string>();
  const noteTried = (slug: string, topic: string, keyword?: string | null) => {
    triedByCat.set(slug, [...(triedByCat.get(slug) ?? []), topic]);
    if (keyword) triedKeywords.add(keyword.trim().toLowerCase());
  };
  const demandByCat = new Map<string, string[]>();

  // Ideate one category into candidates (+2 dedup buffer), recording
  // safety-blocked rows immediately. Shared by the first pass and the backfill
  // rounds; `avoidFirst` carries this run's already-tried topics on retries.
  const ideateFor = async (
    slug: string,
    want: number,
    avoidFirst: string[],
    demand: string[],
  ): Promise<TopicCandidate[]> => {
    const { safe, blocked } = await ideateTopics(
      env,
      nameBySlug.get(slug) ?? slug,
      want + 2,
      avoidFirst.length ? [...avoidFirst, ...covered] : covered,
      descBySlug.get(slug),
      runId,
      cfg.safety,
      demand,
    );
    report.ideated += safe.length;
    for (const b of blocked) {
      ideaRows.push({ runId, categorySlug: slug, topic: b.topic, keyword: b.keyword ?? null, status: "safety_blocked", createdAt: ideatedAt });
      noteTried(slug, b.topic, b.keyword);
    }
    // ALL safe ideas become candidates, in LLM order. The style slots are
    // consumed at enqueue time (queue.ts slot-fill): a duplicate does not burn
    // a slot, so the ideation buffer (+2 above) actually backfills it instead
    // of being discarded unused.
    return safe.map((idea) => ({
      topic: idea.topic,
      categorySlug: slug,
      keyword: idea.keyword,
      titleHint: idea.topic,
      source: "llm-ideation",
    }));
  };

  // Record enqueue outcomes 1:1 against their candidates (pipeline_ideas audit)
  // and remember every proposal for the retry avoid/screen lists.
  const recordOutcomes = (cands: TopicCandidate[], outcomes: EnqueueOutcome[]) => {
    cands.forEach((c, i) => {
      const o = outcomes[i];
      ideaRows.push({
        runId,
        categorySlug: c.categorySlug,
        topic: cleanText(c.topic),
        keyword: cleanText(c.keyword) || null,
        status: o?.status ?? "dup",
        dupReason: o?.reason ?? null,
        dupScore: o?.score ?? null,
        matchedTitle: o?.matched ?? null,
        queueId: o?.queueId ?? null,
        createdAt: ideatedAt,
      });
      noteTried(c.categorySlug, c.topic, c.keyword);
    });
  };

  for (const [slug, list] of byCat) {
    // Real search-demand pool: GSC proven queries (KV-cached, best-effort);
    // empty on failure/disabled -> ideation falls back to LLM free-choice.
    const demand = mergeDemand(gscByCat.get(slug) ?? [], [], cfg.seo.gsc.maxPerCategory);
    demandByCat.set(slug, demand);
    candidates.push(...(await ideateFor(slug, list.length, [], demand)));
    slots.set(slug, [...list]);
  }

  // 4. Enqueue with dedup + slot backfill.
  const enq = await enqueueTopics(env, candidates, { slots });
  report.enqueued = enq.inserted.length;
  report.skippedDuplicates = enq.skipped.length;

  // 5. Record the enqueued/dup/unused ideas (outcomes align 1:1 with candidates).
  recordOutcomes(candidates, enq.outcomes);

  // 6. Backfill still-open slots (max BACKFILL_ROUNDS extra rounds). In a
  // saturated niche an entire slot's candidates can dedup away (2026-07-12:
  // planned 3, delivered 1) and the day silently under-delivers. Each retry
  // re-ideates ONLY the open slots, avoiding everything already proposed this
  // run, on the demand pool minus the queries already tried.
  for (let round = 1; round <= BACKFILL_ROUNDS; round++) {
    const open = [...slots].filter(([, styleList]) => styleList.length > 0);
    if (open.length === 0) break;
    await setRunPhase(env, runId, "ideation", `Bu slot trong - nghi lai y tuong (vong ${round})`);
    log.info("plan.backfill", { runId, round, open: open.map(([s, l]) => `${s}:${l.length}`) });
    const retry: TopicCandidate[] = [];
    for (const [slug, styleList] of open) {
      const demandLeft = (demandByCat.get(slug) ?? []).filter(
        (q) => !triedKeywords.has(q.trim().toLowerCase()),
      );
      retry.push(...(await ideateFor(slug, styleList.length, triedByCat.get(slug) ?? [], demandLeft)));
    }
    if (retry.length === 0) break;
    const enqR = await enqueueTopics(env, retry, { slots });
    report.enqueued += enqR.inserted.length;
    report.skippedDuplicates += enqR.skipped.length;
    recordOutcomes(retry, enqR.outcomes);
  }

  await recordIdeas(env, ideaRows);
  return nameBySlug;
}

// The actual pipeline. Split out so runBatch can wrap it in run bookkeeping.
// Plans + enqueues (planAndEnqueue), then produces each pending item inline,
// stopping at the wall-clock budget. The cron uses planAndEnqueue + queue
// fan-out instead of this inline loop (see src/index.ts).
async function produce(
  env: Bindings,
  cfg: RuntimeConfig,
  opts: RunOptions,
  runId: string,
  startedAt: number,
  report: RunReport,
): Promise<void> {
  const budgetMs = cfg.pipeline.timeBudgetMs || 25_000;

  // 1-4. Plan, ideate, enqueue.
  const nameBySlug = await planAndEnqueue(env, cfg, opts.count, runId, report);

  // 5. Produce each pending item.
  const used = await usedPhotoIds(env);
  const pending = await popPending(env, opts.count);
  for (let i = 0; i < pending.length; i++) {
    // Stop before starting another item if we are over the wall-clock budget
    // (a deployed Worker has a duration ceiling). Remaining items stay pending
    // for the next run; the run is reported as "partial".
    if (i > 0 && Date.now() - startedAt > budgetMs) {
      report.timedOut = true;
      log.warn("run.time_budget", { runId, produced: i, remaining: pending.length - i });
      break;
    }
    const item = pending[i];
    const categoryName = nameBySlug.get(item.categorySlug) ?? item.categorySlug;
    try {
      await produceItem(env, cfg, item, categoryName, runId, used, report, {
        backdateDays: opts.backdateDays ?? 0,
        index: i,
        total: pending.length,
      });
    } catch (err) {
      // Only BudgetExceededError escapes produceItem (every remaining item would
      // fail the same way) - stop the run here.
      if (err instanceof BudgetExceededError) {
        log.error("run.budget_stop", { runId, remaining: pending.length - i - 1 });
        break;
      }
      throw err;
    }
  }
}

// Generate + publish (or hold for review) ONE queue item. Shared by the run
// loop above and the admin "Chay ngay" action. Claims the item as 'generating'
// (reclaimable on a crash), then marks it failed on any error and pushes the
// outcome onto the report. Only BudgetExceededError is re-thrown so the caller
// can stop a multi-item run early.
async function produceItem(
  env: Bindings,
  cfg: RuntimeConfig,
  item: ContentQueueItem,
  categoryName: string,
  runId: string,
  used: Set<string>,
  report: RunReport,
  opts: { backdateDays?: number; index?: number; total?: number },
): Promise<void> {
  const maxAttempts = cfg.pipeline.maxGenAttempts || DEFAULT_MAX_GEN_ATTEMPTS;
  const style: StyleAssignment = {
    categorySlug: item.categorySlug,
    personaSlug: item.personaSlug ?? niche.personas[0]?.slug ?? "",
    formula: item.formula ?? "pas",
    articleType: item.articleType ?? "how-to",
    targetWords: item.targetWords ?? 1300,
    lengthBucket: "medium",
  };
  await markGenerating(env, item.id, runId);
  await setRunPhase(env, runId, "generating", item.topic);
  try {
    const article = await generateArticle(
      env,
      style,
      { topic: item.topic, categoryName, keyword: item.keyword ?? undefined },
      {
        maxAttempts,
        track: { runId, queueId: item.id },
        quality: cfg.quality,
        safety: cfg.safety,
        prompts: cfg.prompts,
      },
    );

    // In-body internal linking (best-effort, LLM free-first) - weave natural
    // contextual links to related published posts into the draft before it is
    // published or held for review. Never throws; leaves the body as-is on error.
    const linked = await addInternalLinks(env, cfg, {
      title: article.title,
      keyword: item.keyword ?? undefined,
      categorySlug: item.categorySlug,
      bodyHtml: article.bodyHtml,
    });
    article.bodyHtml = linked.bodyHtml;

    if (cfg.publish.mode === "review") {
      // Hold the finished draft for /admin/review instead of publishing.
      await markAwaitingReview(env, item.id, article, article.qualityScore);
      report.held.push({ topic: item.topic, category: item.categorySlug });
      log.info("run.held_for_review", { runId, queueId: item.id });
      return;
    }

    await setRunPhase(env, runId, "publishing", item.topic);
    const out = await publishGenerated(env, article, {
      queueId: item.id,
      categorySlug: item.categorySlug,
      personaSlug: style.personaSlug,
      categoryName,
      publishedAt: backdatedISO(opts.backdateDays ?? 0, opts.index ?? 0, opts.total ?? 1),
      usedPhotoIds: used,
    });

    // Topic-cluster assignment (best-effort, LLM free-first): file the freshly
    // published post into its cluster + refresh the pillar page. Post-publish so
    // the post row exists to reference.
    const clu = await assignCluster(env, cfg, {
      postId: out.postId,
      title: article.title,
      excerpt: article.excerpt,
      categorySlug: item.categorySlug,
      keyword: item.keyword ?? undefined,
    });
    // Ping IndexNow for the (new/updated) pillar page so engines re-crawl it.
    // Only on live generation - the backfill calls assignCluster directly, so it
    // does not fan out one IndexNow request per post.
    if (clu) {
      const site = siteConfig(env);
      await submitIndexNow(env, [
        absUrl(site, routes.cluster(clu.slug)),
        absUrl(site, routes.clusters()),
      ]).catch(() => {});
    }
    report.published.push({
      slug: out.slug,
      title: article.title,
      category: item.categorySlug,
      photo: out.coverPhotoId ?? "(none)",
    });
  } catch (err) {
    const msg = errStr(err);
    await markFailed(env, item.id, msg);
    report.failed.push({ topic: item.topic, error: msg });
    log.warn("publish.fail", { runId, queueId: item.id, err: msg });
    if (err instanceof BudgetExceededError) throw err;
  }
}

// A run started for one queue item, ready to generate. beginQueueItemRun does
// the synchronous, fast part (validate + claim a run id) so the caller can
// redirect to the run page immediately; runPreparedItem does the slow LLM work
// and can be handed to waitUntil() to run in the background.
export interface PreparedRun {
  runId: string;
  startedAt: number;
  item: ContentQueueItem;
  categoryName: string;
}

// Synchronously validate the item is pending and open a 'running' pipeline_runs
// row. Throws (before creating any run) if the item is not runnable, so the
// caller can flash the error without an orphaned run. Fast: no LLM calls.
export async function beginQueueItemRun(
  env: Bindings,
  queueId: number,
): Promise<PreparedRun> {
  const d = db(env.DB);
  const item = await d
    .select()
    .from(contentQueue)
    .where(and(eq(contentQueue.id, queueId), eq(contentQueue.status, "pending")))
    .get();
  if (!item) {
    throw new Error(
      `Queue #${queueId} is not pending (it may already have run, been skipped, or been published).`,
    );
  }
  const cat = await d
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.slug, item.categorySlug))
    .get();
  const { runId, startedAt } = await startRun(env, "manual");
  return { runId, startedAt, item, categoryName: cat?.name ?? item.categorySlug };
}

// The slow half: generate + publish/hold the prepared item and close the run.
// NEVER throws - always calls finishRun (so the run can never be left dangling
// in 'running'), which is what makes it safe to run under waitUntil where no
// caller awaits it. Skips ideation/enqueue (topic already exists) and the kill
// switch (explicit admin action); the budget guard inside chat() still applies.
export async function runPreparedItem(
  env: Bindings,
  prepared: PreparedRun,
): Promise<RunReport> {
  const { runId, startedAt, item, categoryName } = prepared;
  const cfg = await getConfig(env);
  const report: RunReport = {
    runId,
    status: "running",
    requested: 1,
    ideated: 0,
    enqueued: 0,
    skippedDuplicates: 0,
    published: [],
    failed: [],
    held: [],
  };
  try {
    const used = await usedPhotoIds(env);
    await produceItem(env, cfg, item, categoryName, runId, used, report, {});
    const produced = report.published.length + report.held.length;
    report.status = report.failed.length && !produced ? "failed" : "ok";
    await finishRun(env, { runId, startedAt, status: report.status, report });
  } catch (err) {
    report.status = "failed";
    await finishRun(env, { runId, startedAt, status: "failed", report, error: errStr(err) });
    log.error("run.queue_item_failed", { runId, err: errStr(err) });
  }
  return report;
}

// Synchronous convenience (begin + generate in one await). Used by tests; the
// admin route uses begin + waitUntil(runPreparedItem) instead so a client
// disconnect can never orphan the run.
export async function runQueueItem(env: Bindings, queueId: number): Promise<RunReport> {
  const prepared = await beginQueueItemRun(env, queueId);
  return runPreparedItem(env, prepared);
}

// Consumer-side rebuild of a PreparedRun from a job (the run row already exists,
// created by the admin route). Re-fetches the item + category; the item may be
// 'pending' (not yet claimed) or 'generating' (claimed) - both are runnable.
async function loadPreparedRun(
  env: Bindings,
  runId: string,
  startedAt: number,
  queueId: number,
): Promise<PreparedRun | null> {
  const d = db(env.DB);
  const item = await d
    .select()
    .from(contentQueue)
    .where(
      and(
        eq(contentQueue.id, queueId),
        inArray(contentQueue.status, ["pending", "generating"]),
      ),
    )
    .get();
  if (!item) return null;
  const cat = await d
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.slug, item.categorySlug))
    .get();
  return { runId, startedAt, item, categoryName: cat?.name ?? item.categorySlug };
}

// The queue consumer entry point: run one background generation job. NEVER
// throws (runBatch/runPreparedItem always finishRun; anything else is caught and
// swallowed) so the message is acked and the queue does not retry into a
// double-generation. The run row it targets was opened by the admin route.
export async function runGenerateJob(env: Bindings, job: GenerateJob): Promise<void> {
  try {
    if (job.kind === "batch") {
      await runBatch(env, {
        count: job.count,
        trigger: "manual",
        preStarted: { runId: job.runId, startedAt: job.startedAt },
      });
      return;
    }
    const prepared = await loadPreparedRun(env, job.runId, job.startedAt, job.queueId);
    if (!prepared) {
      await finishRun(env, {
        runId: job.runId,
        startedAt: job.startedAt,
        status: "failed",
        error: `Queue #${job.queueId} is no longer in a runnable state`,
      });
      return;
    }
    await runPreparedItem(env, prepared);
  } catch (e) {
    log.error("generate.job_failed", { job, err: errStr(e) });
  }
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface GeneratedArticle extends Draft {
  imageQuery: string;
  qualityScore?: number; // critic pass score (only when quality.criticEnabled)
  faq?: FaqItem[]; // visible FAQ appended to the body + FAQPage JSON-LD on publish
}

// Parse the LLM's `faq` field into at most 3 clean, non-empty Q&A pairs (best-
// effort: a missing/malformed field yields []). cleanText strips AI-tell glyphs.
export function parseFaq(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FaqItem[] = [];
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    const q = cleanText(str(o.q)).trim();
    const a = cleanText(str(o.a)).trim();
    if (q.length >= 6 && a.length >= 10) out.push({ q, a });
    if (out.length >= 3) break;
  }
  return out;
}

// Drop FAQ items that add no value (audit 2026-07-10: FAQ answers were
// restating body sentences = padding to a quality rater, and nothing stopped
// the same question recurring across many articles). Token-set Jaccard on
// normalized text - the same primitive as topic dedup.
// A visible FAQ question survives only if it "covers" a real demand query: at
// least this fraction of the query's content tokens appear in the question.
// Lower = more FAQs survive; higher = stricter/fewer. Watch the drop rate via the
// "faq.filtered" log (reason "question-no-demand") before retuning.
const FAQ_DEMAND_MIN_CONTAINMENT = 0.6;

export function filterFaq(
  faq: FaqItem[],
  ctx: { bodyHtml: string; recentQuestions?: string[]; demand?: string[] },
): { kept: FaqItem[]; dropped: { q: string; reason: string }[] } {
  const headings = [...ctx.bodyHtml.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((m) => normalizeTopic(stripHtml(m[1])))
    .filter((n) => n.tokens.size > 0);
  const sentences = splitSentences(stripHtml(ctx.bodyHtml))
    .map((s) => normalizeTopic(s))
    .filter((n) => n.tokens.size > 0);
  const recent = (ctx.recentQuestions ?? [])
    .map((q) => normalizeTopic(q))
    .filter((n) => n.tokens.size > 0);
  // Real search-demand queries (the category demand pool + the article's seed
  // keyword). Single-token queries are dropped so one generic category noun cannot
  // act as a skeleton key that keeps every question.
  const demandSets = (ctx.demand ?? [])
    .map((q) => normalizeTopic(q))
    .filter((n) => n.tokens.size >= 2);

  const kept: FaqItem[] = [];
  const dropped: { q: string; reason: string }[] = [];
  for (const item of faq) {
    const qn = normalizeTopic(item.q);
    if (headings.some((h) => jaccard(qn.tokens, h.tokens) >= 0.7)) {
      dropped.push({ q: item.q, reason: "question-restates-heading" });
      continue;
    }
    if (recent.some((r) => jaccard(qn.tokens, r.tokens) >= 0.75)) {
      dropped.push({ q: item.q, reason: "question-used-recently" });
      continue;
    }
    // Demand gate (fail-open): when we have a demand signal, keep only questions
    // that "cover" a real query (>= FAQ_DEMAND_MIN_CONTAINMENT of the query's
    // content tokens appear in the question). No demand signal -> keep as before,
    // so a new property / empty pool never strips every FAQ.
    if (
      demandSets.length &&
      !demandSets.some((d) => containment(d.tokens, qn.tokens) >= FAQ_DEMAND_MIN_CONTAINMENT)
    ) {
      dropped.push({ q: item.q, reason: "question-no-demand" });
      continue;
    }
    const restated = splitSentences(item.a).some((as) => {
      const an = normalizeTopic(as);
      return an.tokens.size > 0 && sentences.some((sn) => jaccard(an.tokens, sn.tokens) >= 0.7);
    });
    if (restated) {
      dropped.push({ q: item.q, reason: "answer-restates-body" });
      continue;
    }
    kept.push(item);
  }
  return { kept, dropped };
}

// Sentence split for the restate check; short fragments carry no signal.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

// Questions recent articles' FAQ blocks already used (parsed back out of the
// stored FAQPage JSON-LD) - fed to the prompt as an avoid-list and to filterFaq
// as the mechanical backstop, so the same question does not creep across the
// whole site. Best-effort: malformed rows are skipped.
async function recentFaqQuestions(d: ReturnType<typeof db>, limit = 40): Promise<string[]> {
  const rows = await d
    .select({ schemaJson: posts.schemaJson })
    .from(posts)
    .where(isNotNull(posts.schemaJson))
    .orderBy(desc(posts.id))
    .limit(limit)
    .all();
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.schemaJson ?? "") as { mainEntity?: unknown[] };
      for (const q of Array.isArray(parsed?.mainEntity) ? parsed.mainEntity : []) {
        const name = (q as { name?: unknown })?.name;
        if (typeof name === "string" && name) out.add(name);
      }
    } catch {
      // not FAQPage JSON / malformed - ignore
    }
  }
  return [...out];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Render the FAQ as a plain, always-visible section using only whitelisted tags
// (survives cleanHtml, reads as normal article prose, and is indexed into FTS).
export function renderFaqHtml(faq: FaqItem[]): string {
  const rows = faq
    .map((f) => `<h3>${escapeHtml(f.q)}</h3>\n<p>${escapeHtml(f.a)}</p>`)
    .join("\n");
  return `\n<h2>Frequently asked questions</h2>\n${rows}\n`;
}

export interface GenerateOptions {
  maxAttempts?: number;
  track?: { runId?: string; queueId?: number };
  quality?: {
    minWords: number;
    hardMinWords?: number; // salvage floor (see the salvage note in generateArticle)
    criticEnabled: boolean;
    criticMinScore: number;
  };
  safety?: SafetyConfig; // content safety gate (HARD reject / SOFT over-threshold)
  prompts?: PromptOverrides; // admin-editable house voice / tone / persona seeds
  demandPool?: string[]; // category demand queries -> gates the visible FAQ (fail-open)
}

// How many surgical repair rounds per outline before giving up on it and rolling
// a fresh one. Repairs are cheap and targeted, but a draft still failing after
// two of them has something wrong with its plan, not its prose.
const REPAIR_ROUNDS = 2;

// Section calls run concurrently. Capped because some providers have a
// tokens-per-minute ceiling a full fan-out would trip (see runtime-config llm.models).
const SECTION_CONCURRENCY = 3;

// Most a single section may be asked to grow in one repair round. Keeps the
// expand call's output inside its token budget and stops one section from
// swelling into the whole article.
const MAX_EXPAND_WORDS = 220;

// The article as separately-generated parts. Keeping it in pieces until the very
// end is what makes repair surgical: a thin section is expanded on its own, a
// banned closer rewrites only the ending, everything else stays byte-identical.
interface ArticleParts {
  lead: string;
  sections: string[]; // 1:1 with outline.sections
  ending: string;
}

// Bounded-concurrency map (Promise.all would fan out unbounded).
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Ask for one {"html": "..."} fragment. Sections must not carry their own <h2>
// (the assembler owns those, so the outline's heading text is what ships and the
// h2 count is guaranteed) - a stray one is demoted to <h3> rather than rejected.
async function chatFragment(
  env: Bindings,
  prompts: { system: string; user: string },
  gen: GenerateOptions,
  stage: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await chat(env, {
    system: prompts.system,
    user: prompts.user,
    json: true,
    temperature: opts.temperature ?? 0.85,
    maxTokens: opts.maxTokens ?? 1600,
    track: { runId: gen.track?.runId, queueId: gen.track?.queueId, stage },
  });
  const parsed = parseJsonObject<{ html?: unknown }>(res.text);
  const html = typeof parsed.html === "string" ? parsed.html.trim() : "";
  if (!html) throw new Error(`${stage}: thieu truong html`);
  return html.replace(/<(\/?)h2\b/gi, "<$1h3");
}

// Plan the article: title, core message, and one job + one concrete element per
// section. Cheap, and everything structural is decided here - so a bad plan is
// caught before any prose is paid for.
async function buildOutline(
  env: Bindings,
  style: StyleAssignment,
  input: { topic: string; categoryName: string; keyword?: string },
  gen: GenerateOptions,
  extra: { tagVocab: string[]; faqAvoid: string[]; avoidNote?: string },
): Promise<Outline> {
  const plan = planArticle(style.targetWords);
  const p = outlinePrompt(
    style,
    { ...input, tagVocab: extra.tagVocab, faqAvoid: extra.faqAvoid },
    gen.prompts,
  );
  const res = await chat(env, {
    system: p.system,
    user: extra.avoidNote ? `${p.user}\n\n${extra.avoidNote}` : p.user,
    json: true,
    temperature: 0.9,
    maxTokens: 2000,
    track: { runId: gen.track?.runId, queueId: gen.track?.queueId, stage: "outline" },
  });
  const parsed = parseJsonObject<Record<string, unknown>>(res.text);

  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((raw) => {
      const o = raw as Record<string, unknown>;
      return { h2: str(o.h2), job: str(o.job), must: str(o.must) };
    })
    .filter((s) => s.h2)
    .slice(0, plan.sectionCount);
  // Two H2s is the published floor (validate.ts "body.h2"); below that the plan
  // is unusable and there is nothing to repair, so re-roll.
  if (sections.length < 2) throw new Error("outline: not enough h2 sections");

  return {
    title: str(parsed.title),
    coreMessage: str(parsed.coreMessage),
    excerpt: str(parsed.excerpt),
    metaTitle: str(parsed.metaTitle),
    metaDescription: str(parsed.metaDescription),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    imageQuery: str(parsed.imageQuery),
    sections,
    faq: parseFaq(parsed.faq),
  };
}

// Write every part. The lead goes first because the ending is allowed to close
// its loop (call back to the opening image), so it needs the real text; the
// sections do not depend on each other and run concurrently.
async function writeParts(
  env: Bindings,
  style: StyleAssignment,
  outline: Outline,
  gen: GenerateOptions,
): Promise<ArticleParts> {
  const lead = await chatFragment(env, leadPrompt(style, outline, gen.prompts), gen, "lead", {
    maxTokens: 900,
  });
  const [sections, ending] = await Promise.all([
    mapLimit(outline.sections, SECTION_CONCURRENCY, (_s, i) =>
      chatFragment(env, sectionPrompt(style, outline, i, gen.prompts), gen, "section"),
    ),
    chatFragment(env, endingPrompt(style, outline, lead, gen.prompts), gen, "ending", {
      maxTokens: 700,
    }),
  ]);
  return { lead, sections, ending };
}

function assembleBody(outline: Outline, parts: ArticleParts): string {
  const body = outline.sections.map(
    (s, i) => `<h2>${escapeHtml(s.h2)}</h2>\n${parts.sections[i] ?? ""}`,
  );
  return [parts.lead, ...body, parts.ending].filter(Boolean).join("\n");
}

function draftFrom(outline: Outline, parts: ArticleParts): Draft {
  return {
    title: outline.title,
    excerpt: outline.excerpt,
    // Keep body HTML raw here; publishPost runs cleanHtml before it is stored.
    bodyHtml: assembleBody(outline, parts),
    // Drop a metaTitle more sensational than the title so the browser-tab/SEO
    // title stays consistent with the on-page h1.
    metaTitle: reconcileMetaTitle(outline.title, outline.metaTitle),
    metaDescription: outline.metaDescription,
    tags: outline.tags,
  };
}

function wordsIn(html: string): number {
  const text = stripHtml(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

// Which parts carry the offending text. The `fix` hint quotes the guilty phrase,
// so a text match localizes the repair; with nothing to match on, every part is a
// candidate.
function partsContaining(
  parts: ArticleParts,
  issue: Issue,
): { kind: "lead" | "section" | "ending"; index: number; label: string; html: string }[] {
  const all = [
    { kind: "lead" as const, index: -1, label: "mo bai", html: parts.lead },
    ...parts.sections.map((html, index) => ({
      kind: "section" as const,
      index,
      label: `muc ${index + 1}`,
      html,
    })),
    { kind: "ending" as const, index: -1, label: "ket bai", html: parts.ending },
  ];
  const quoted = issue.fix.match(/"([^"]+)"/)?.[1];
  if (!quoted) return all;
  const needle = foldAscii(quoted);
  const hits = all.filter((p) => foldAscii(stripHtml(p.html)).includes(needle));
  return hits.length ? hits : all;
}

// Drop paragraphs repeated verbatim across the body. Keeps the first occurrence;
// no LLM call needed to delete a duplicate.
function dedupeParagraphs(sections: string[]): string[] {
  const seen = new Set<string>();
  return sections.map((html) =>
    html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (match, inner: string) => {
      const key = foldAscii(stripHtml(inner));
      if (key.length <= 40) return match;
      if (seen.has(key)) return "";
      seen.add(key);
      return match;
    }),
  );
}

// One round of targeted repairs: each issue is routed to the ONE part that owns
// it, everything else is left untouched.
async function repairParts(
  env: Bindings,
  style: StyleAssignment,
  outline: Outline,
  parts: ArticleParts,
  issues: Issue[],
  verdict: Verdict,
  gen: GenerateOptions,
): Promise<{ outline: Outline; parts: ArticleParts }> {
  const next: ArticleParts = { ...parts, sections: [...parts.sections] };
  let nextOutline = outline;
  const minWords = gen.quality?.minWords ?? 600;

  for (const issue of issues) {
    switch (issue.code) {
      case "body.too_short": {
        // Expand the THINNEST sections first - that is where the deficit is, and
        // expanding an already-full section is what produces padding. Spread the
        // shortfall over at most two sections so neither gets bloated.
        const deficit = Math.max(0, minWords - verdict.stats.words);
        const ranked = next.sections
          .map((html, i) => ({ i, words: wordsIn(html) }))
          .sort((a, b) => a.words - b.words)
          .slice(0, 2);
        if (!ranked.length) break;
        // Cap what one section is asked to grow by. An expand call returns the
        // WHOLE section, so an unbounded ask (a 2400-word floor against a
        // 1400-word draft wanted +500 each) blows past max_tokens and comes back
        // as truncated, unparseable JSON. A deficit this large is not one bad
        // section anyway - the repair rounds run again, growing it in steps.
        const share = Math.min(MAX_EXPAND_WORDS, Math.ceil(deficit / ranked.length) + 30);
        const expanded = await mapLimit(ranked, SECTION_CONCURRENCY, (t) =>
          chatFragment(
            env,
            expandSectionPrompt(style, nextOutline, t.i, next.sections[t.i], share, gen.prompts),
            gen,
            "expand",
            // Budget for the section coming back whole (old + new), not just the
            // delta. English runs ~1.4 tokens per word; 2.5 leaves generous headroom for JSON/tag overhead.
            { temperature: 0.7, maxTokens: Math.round((t.words + share) * 2.5) + 600 },
          ).catch(() => next.sections[t.i]), // a failed expand keeps the old text
        );
        ranked.forEach((t, k) => (next.sections[t.i] = expanded[k]));
        break;
      }
      case "body.opener":
        next.lead = await chatFragment(
          env,
          patchPartPrompt(style, { label: "mo bai", html: next.lead }, issue.fix, gen.prompts),
          gen,
          "patch",
          { temperature: 0.8, maxTokens: 900 },
        );
        break;
      case "body.closer":
        next.ending = await chatFragment(
          env,
          patchPartPrompt(style, { label: "ket bai", html: next.ending }, issue.fix, gen.prompts),
          gen,
          "patch",
          { temperature: 0.8, maxTokens: 700 },
        );
        break;
      case "body.dup_para":
        next.sections = dedupeParagraphs(next.sections);
        break;
      case "title.short":
      case "title.hook":
      case "title.metaphor":
      case "title.opener":
      case "title.localizer": {
        const p = patchTitlePrompt(style, nextOutline, issue.fix, gen.prompts);
        const res = await chat(env, {
          system: p.system,
          user: p.user,
          json: true,
          temperature: 0.8,
          maxTokens: 300,
          track: { runId: gen.track?.runId, queueId: gen.track?.queueId, stage: "patch" },
        });
        const parsed = parseJsonObject<{ title?: unknown; metaTitle?: unknown }>(res.text);
        const title = str(parsed.title);
        if (title) nextOutline = { ...nextOutline, title, metaTitle: str(parsed.metaTitle) };
        break;
      }
      default: {
        // Body-wide issues (hook / localizer / stray tag): the offending phrase
        // can sit in any part, so patch every part that actually contains it.
        for (const t of partsContaining(next, issue)) {
          const fixed = await chatFragment(
            env,
            patchPartPrompt(style, { label: t.label, html: t.html }, issue.fix, gen.prompts),
            gen,
            "patch",
            { temperature: 0.7, maxTokens: 2000 },
          ).catch(() => t.html);
          if (t.kind === "lead") next.lead = fixed;
          else if (t.kind === "ending") next.ending = fixed;
          else next.sections[t.index] = fixed;
        }
        break;
      }
    }
  }
  return { outline: nextOutline, parts: next };
}

// Keep whichever candidate is closer to publishable: fewest issues, then most
// words (length is the axis that actually varies here).
function pickBest(
  current: { article: GeneratedArticle; verdict: Verdict } | null,
  candidate: { article: GeneratedArticle; verdict: Verdict },
): { article: GeneratedArticle; verdict: Verdict } {
  if (!current) return candidate;
  const a = current.verdict;
  const b = candidate.verdict;
  if (b.issues.length !== a.issues.length) {
    return b.issues.length < a.issues.length ? candidate : current;
  }
  return b.stats.words > a.stats.words ? candidate : current;
}

// A draft is salvageable only when length is its ONLY complaint and it still
// clears the hard floor. Structure, safety and empty-body failures are never
// salvaged.
function isSalvageable(verdict: Verdict, hardMinWords: number): boolean {
  return (
    verdict.issues.length > 0 &&
    verdict.issues.every((i) => i.code === "body.too_short") &&
    verdict.stats.words >= hardMinWords
  );
}

// Attach the visible FAQ and run the optional critic. Returns null when the
// critic rejects the draft (the caller re-rolls). `outline` is null on the
// salvage path, where the FAQ is skipped along with the critic.
async function finishArticle(
  env: Bindings,
  outline: Outline | null,
  draft: Draft,
  gen: GenerateOptions,
  ctx: { faqAvoid: string[]; faqDemand: string[]; skipCritic?: boolean },
): Promise<GeneratedArticle | null> {
  const withFaq: Draft = { ...draft };
  let faq: FaqItem[] = [];

  // Visible FAQ (best-effort): appended after the structural gate so it does not
  // affect the h2/word validation of the core draft. filterFaq drops items that
  // restate the body/headings or recycle a question a recent article answered;
  // checkSafety then drops any item that would carry a blocked term onto the page.
  if (outline?.faq.length) {
    const { kept, dropped } = filterFaq(outline.faq, {
      bodyHtml: withFaq.bodyHtml,
      recentQuestions: ctx.faqAvoid,
      demand: ctx.faqDemand,
    });
    faq = kept.filter((f) => checkSafety(`${f.q}\n${f.a}`, gen.safety).ok);
    const unsafe = kept.length - faq.length;
    if (dropped.length || unsafe) {
      log.info("faq.filtered", {
        runId: gen.track?.runId,
        queueId: gen.track?.queueId,
        dropped,
        unsafe,
      });
    }
    if (faq.length) withFaq.bodyHtml += renderFaqHtml(faq);
  }

  const imageQuery = outline?.imageQuery ?? "";
  if (gen.quality?.criticEnabled && !ctx.skipCritic) {
    const critic = await criticScore(env, withFaq, gen);
    if (critic && critic.score < gen.quality.criticMinScore) {
      log.info("critic.rejected", {
        runId: gen.track?.runId,
        queueId: gen.track?.queueId,
        score: critic.score,
        reasons: critic.reasons,
      });
      return null;
    }
    return { ...withFaq, faq, imageQuery, qualityScore: critic?.score };
  }
  return { ...withFaq, faq, imageQuery };
}

// Generate one article: plan -> write the parts -> validate -> REPAIR the
// offending part (not the article) -> publish. A fresh outline is only rolled
// when the draft has nothing salvageable, because prod telemetry proved a blind
// re-roll is close to a no-op: regen ran 3.7% longer than draft across 52 calls,
// and 9 of 10 failed items died on "body: too short" after burning 3 full drafts.
export async function generateArticle(
  env: Bindings,
  style: StyleAssignment,
  input: { topic: string; categoryName: string; keyword?: string },
  gen: GenerateOptions = {},
): Promise<GeneratedArticle> {
  // Controlled tag vocabulary: feed the most-used existing tags into the prompt
  // so the model reuses them (max 1 new tag). Best-effort - an empty vocab just
  // means free-form tags for this article.
  const tagVocab = await getTagVocabulary(db(env.DB), 40).catch(() => []);
  // FAQ avoid-list: questions recent articles already answered (best-effort).
  const faqAvoid = await recentFaqQuestions(db(env.DB)).catch(() => [] as string[]);
  // Demand signal for the visible-FAQ gate: the category demand pool supplied by
  // the caller plus this article's own seed keyword. Empty -> the gate fails open.
  const faqDemand = [...(gen.demandPool ?? []), input.keyword].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  const maxAttempts = gen.maxAttempts ?? DEFAULT_MAX_GEN_ATTEMPTS;
  const track = { runId: gen.track?.runId, queueId: gen.track?.queueId };

  let lastErrors: string[] = [];
  let avoidNote: string | undefined;
  // Best draft seen across attempts, for the salvage path at the bottom.
  let best: { article: GeneratedArticle; verdict: Verdict } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let outline: Outline;
    let parts: ArticleParts;
    try {
      outline = await buildOutline(env, style, input, gen, { tagVocab, faqAvoid, avoidNote });
      // Kill a bad plan before writing six sections against it.
      const planSafety = checkSafety(
        `${outline.title}\n${outline.coreMessage}\n${outline.sections
          .map((s) => `${s.h2} ${s.job}`)
          .join("\n")}`,
        gen.safety,
      );
      if (planSafety.hardHits.length) {
        const terms = [...new Set(planSafety.hardHits.map((h) => h.term))];
        lastErrors = [`safety: unsafe outline (blocked): ${terms.join(", ")}`];
        avoidNote = `The previous outline was blocked for touching forbidden content: ${terms.join(", ")}. Draft the outline from a completely different, safe angle and never mention these topics or words.`;
        continue;
      }
      parts = await writeParts(env, style, outline, gen);
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      lastErrors = [errStr(e)];
      log.warn("generate.plan_failed", { ...track, attempt, err: errStr(e) });
      continue;
    }

    // Repair rounds: validate the assembled body, fix the offending part, retry.
    let rerollNeeded = false;
    for (let round = 0; round <= REPAIR_ROUNDS; round++) {
      const draft = draftFrom(outline, parts);
      const verdict = validateDraft(draft, {
        targetWords: style.targetWords,
        minWords: gen.quality?.minWords,
      });
      const safe = checkSafety(
        `${draft.title}\n${draft.excerpt}\n${stripHtml(draft.bodyHtml)}`,
        gen.safety,
      );

      // A HARD safety hit is never repairable - the plan itself is wrong.
      if (safe.hardHits.length) {
        const terms = [...new Set(safe.hardHits.map((h) => h.term))];
        lastErrors = [`safety: unsafe content (blocked): ${terms.join(", ")}`];
        avoidNote = `The previous article was blocked for touching forbidden content: ${terms.join(", ")}. Write from a completely different, safe angle and never mention these topics or words.`;
        rerollNeeded = true;
        break;
      }

      const issues = [...verdict.issues];
      if (!safe.ok) {
        // SOFT over threshold: too morbid. Repairable - patch the parts carrying
        // the words. Routed through the generic text-match patcher.
        const terms = [...new Set(safe.softHits.map((h) => h.term))];
        issues.push({
          code: "body.hook",
          message: `safety: soft tone (${terms.join(", ")})`,
          fix: `The tone is too heavy or gruesome because of the word "${terms[0]}". Write more gently and warmly and remove these words: ${terms.join(", ")}.`,
        });
      }

      if (issues.length === 0) {
        const article = await finishArticle(env, outline, draft, gen, { faqAvoid, faqDemand });
        if (article) return article;
        // Critic rejected it: a whole-draft judgement, so there is no single part
        // to patch. Re-roll, keeping this one as a salvage candidate.
        lastErrors = ["critic: diem duoi nguong"];
        best = pickBest(best, {
          article: { ...draft, faq: [], imageQuery: outline.imageQuery },
          verdict,
        });
        rerollNeeded = true;
        break;
      }

      lastErrors = issues.map((i) => i.message);
      best = pickBest(best, {
        article: { ...draft, faq: [], imageQuery: outline.imageQuery },
        verdict,
      });

      if (!isRepairable(issues) || round === REPAIR_ROUNDS) {
        rerollNeeded = true;
        break;
      }
      log.info("generate.repair", {
        ...track,
        attempt,
        round,
        words: verdict.stats.words,
        codes: issues.map((i) => i.code),
      });
      try {
        const repaired = await repairParts(env, style, outline, parts, issues, verdict, gen);
        outline = repaired.outline;
        parts = repaired.parts;
      } catch (e) {
        if (e instanceof BudgetExceededError) throw e;
        log.warn("generate.repair_failed", { ...track, attempt, err: errStr(e) });
        rerollNeeded = true;
        break;
      }
    }
    if (!rerollNeeded) break;
  }

  // Salvage. Losing the day's slot over a handful of words is the worst trade
  // available: a 560-word article that is structurally sound, safety-clean and
  // reads well beats no article at all. So if the best attempt failed ONLY on
  // length and still clears the hard floor, publish it and warn - anything else
  // (thin structure, safety, empty body) still fails the item.
  const hardMin = gen.quality?.hardMinWords ?? 0;
  if (best && hardMin > 0 && isSalvageable(best.verdict, hardMin)) {
    log.warn("generate.salvaged", {
      ...track,
      words: best.verdict.stats.words,
      hardMin,
      errors: best.verdict.errors,
    });
    const salvaged = await finishArticle(env, null, best.article, gen, {
      faqAvoid,
      faqDemand,
      skipCritic: true,
    });
    if (salvaged) return salvaged;
  }

  throw new Error(`generation failed after ${maxAttempts} attempts: ${lastErrors.join("; ")}`);
}

async function criticScore(
  env: Bindings,
  draft: Draft,
  gen: GenerateOptions,
): Promise<{ score: number; reasons: string[] } | null> {
  const { system, user } = criticPrompt({
    title: draft.title,
    excerpt: draft.excerpt,
    bodyHtml: draft.bodyHtml,
  });
  try {
    const res = await chat(env, {
      system,
      user,
      json: true,
      temperature: 0.2,
      maxTokens: 300,
      track: { runId: gen.track?.runId, queueId: gen.track?.queueId, stage: "critic" },
    });
    const parsed = parseJsonObject<{ score?: unknown; reasons?: unknown }>(res.text);
    const score = Math.round(Number(parsed.score));
    if (!Number.isFinite(score)) return null;
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.slice(0, 3).map((r) => cleanText(String(r)))
      : [];
    return { score: Math.min(10, Math.max(1, score)), reasons };
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e; // budget stop must propagate
    log.warn("critic.failed", { err: errStr(e) });
    return null;
  }
}

// Publish one generated article for a queue item: unique slug, real cover photo
// (dedup by photo id), publishPost, and mark the queue row published. Shared by
// the run loop above and the admin review-approve flow.
export async function publishGenerated(
  env: Bindings,
  article: GeneratedArticle,
  opts: {
    queueId: number;
    categorySlug: string;
    personaSlug: string;
    categoryName?: string;
    publishedAt?: string;
    usedPhotoIds?: Set<string>; // pass the batch's set to dedup within a run
  },
): Promise<{ slug: string; coverPhotoId?: string; postId: number }> {
  const d = db(env.DB);
  const slug = await uniqueSlug(d, slugify(article.title));
  const used = opts.usedPhotoIds ?? (await usedPhotoIds(env));

  // Real cover photo (never AI-generated). Fall back gracefully if none.
  let coverImageKey: string | undefined;
  let coverImageAlt: string | undefined;
  let coverPhotoId: string | undefined;
  let photoCredit: string | undefined;
  const images: { key: string; bytes: Uint8Array; contentType: string }[] = [];
  const photo = await fetchPhoto(env, {
    query: article.imageQuery || opts.categoryName || opts.categorySlug,
    usedIds: used,
  }).catch((e) => {
    log.warn("photo.fetch_error", { err: errStr(e) });
    return null;
  });
  if (photo) {
    // A photo download failure/timeout must NOT fail the whole article - publish
    // coverless instead (a missing cover is far better than a lost post / a run
    // hung in the download step).
    try {
      const { bytes, contentType } = await downloadImage(photo.downloadUrl);
      coverImageKey = `uploads/posts/${slug}/cover.${extForContentType(contentType)}`;
      coverImageAlt = photo.alt;
      coverPhotoId = photo.id;
      photoCredit = `${photo.creditName} (${photo.provider}) ${photo.creditUrl}`.trim();
      images.push({ key: coverImageKey, bytes, contentType });
      used.add(photo.id);
    } catch (e) {
      log.warn("photo.download_failed", { id: photo.id, err: errStr(e) });
    }
  }

  // FAQPage JSON-LD (rendered on the post page from posts.schema_json). Built
  // from the same faq[] that produced the visible on-page FAQ, so they never drift.
  const schemaJson = article.faq?.length
    ? JSON.stringify(faqPage(article.faq.map((f) => ({ question: f.q, answer: f.a }))))
    : undefined;

  const result = await publishPost(env, {
    slug,
    categorySlug: opts.categorySlug,
    authorSlug: opts.personaSlug,
    title: article.title,
    excerpt: article.excerpt,
    bodyHtml: article.bodyHtml,
    metaTitle: article.metaTitle,
    metaDescription: article.metaDescription,
    tags: article.tags,
    coverImageKey,
    coverImageAlt,
    images: images.length ? images : undefined,
    publishedAt: opts.publishedAt,
    schemaJson,
  });

  await markPublished(env, opts.queueId, {
    postId: result.id,
    slug: result.slug,
    coverPhotoId,
    photoCredit,
    qualityScore: article.qualityScore,
  });
  return { slug: result.slug, coverPhotoId, postId: result.id };
}

// Ask the LLM for `count` fresh topics for a category, avoiding covered ones.
type IdeaTopic = { topic: string; keyword?: string; imageQuery?: string };

async function ideateTopics(
  env: Bindings,
  categoryName: string,
  count: number,
  covered: string[],
  categoryDescription?: string,
  runId?: string,
  safety?: SafetyConfig,
  demandKeywords?: string[],
): Promise<{ safe: IdeaTopic[]; blocked: IdeaTopic[] }> {
  const { system, user } = ideationPrompt({
    categoryName,
    categoryDescription,
    count,
    coveredTopics: covered,
    demandKeywords,
    seedTopics: niche.topicSeeds[niche.categories.find((c) => c.name === categoryName)?.slug ?? ""],
  });
  const res = await chat(env, {
    system,
    user,
    json: true,
    temperature: 1.0,
    maxTokens: 1500,
    track: { runId, stage: "ideation" },
  });
  try {
    const parsed = parseJsonObject<{ topics?: unknown[] }>(res.text);
    const raw = Array.isArray(parsed.topics) ? parsed.topics : [];
    const topics = raw
      .map((t) => {
        const o = t as Record<string, unknown>;
        return { topic: str(o.topic), keyword: str(o.keyword), imageQuery: str(o.imageQuery) };
      })
      .filter((t) => t.topic);
    // Safety layer 1: drop HARD-blocked topics before they are ever enqueued.
    // Keep the blocked ones so the run can record them (pipeline_ideas audit).
    const safe: IdeaTopic[] = [];
    const blocked: IdeaTopic[] = [];
    for (const t of topics) (hasHardHit(t.topic, safety) ? blocked : safe).push(t);
    if (blocked.length) {
      log.warn("ideation.safety_drop", { runId, category: categoryName, dropped: blocked.length });
    }
    return { safe, blocked };
  } catch {
    return { safe: [], blocked: [] };
  }
}

// Recent post titles + queued topics, as dedup context for ideation.
async function coveredTopics(d: ReturnType<typeof db>): Promise<string[]> {
  const [p, q] = await Promise.all([
    d.select({ title: posts.title }).from(posts).orderBy(desc(posts.id)).limit(120).all(),
    d.select({ topic: contentQueue.topic }).from(contentQueue).limit(120).all(),
  ]);
  // De-dupe and cap so the ideation prompt sees a broad-but-bounded covered set.
  return [...new Set([...p.map((r) => r.title), ...q.map((r) => r.topic)])];
}

// Ensure the slug is unique in posts (append -2, -3, ...).
async function uniqueSlug(d: ReturnType<typeof db>, base: string): Promise<string> {
  let slug = base && isValidSlug(base) ? base : `post-${Date.now()}`;
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`;
    const hit = await d
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.slug, candidate))
      .get();
    if (!hit) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

// Spread publishedAt backward: item 0 is oldest, last item ~ now.
function backdatedISO(spanDays: number, i: number, total: number): string {
  const now = Date.now();
  if (spanDays <= 0 || total <= 1) return new Date(now).toISOString();
  const frac = (total - 1 - i) / (total - 1); // 1 for first, 0 for last
  const ms = frac * spanDays * 24 * 60 * 60 * 1000;
  // Land on a daytime hour so it reads like a real posting cadence.
  return new Date(now - ms).toISOString();
}

function str(v: unknown): string {
  return typeof v === "string" ? cleanText(v) : "";
}
