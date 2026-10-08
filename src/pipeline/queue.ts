// Content queue + topic ledger operations. The queue is the buffer the daily
// generator pops from; the ledger (every row, any status, plus already-published
// posts) is the dedup source of truth so ideation never repeats itself.

import { asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { contentQueue, posts } from "../db/schema";
import type { ContentQueueItem } from "../db/schema";
import type { Bindings } from "../env";
import { cleanText } from "../lib/sanitize";
import { getConfig } from "../lib/runtime-config";
import { isDuplicate, normalizeTopic, type Prior } from "./normalize";

type DB = ReturnType<typeof db>;

// A topic proposed for the queue (by LLM ideation, a cluster expansion, or by
// hand). `topic` is the human brief; the style fields are the deterministic
// rotation assignment (set by task #5) carried through to generation.
export interface TopicCandidate {
  topic: string;
  categorySlug: string;
  titleHint?: string;
  keyword?: string;
  articleType?: string;
  formula?: string;
  personaSlug?: string;
  targetWords?: number;
  priority?: number;
  source?: string; // llm-ideation | manual | cluster-expansion
  scheduledFor?: string; // ISO date (backfill backdating)
}

// The style fields a slot carries in slot-fill mode (see enqueueTopics).
// Structurally satisfied by rotation.ts's StyleAssignment.
export type SlotStyle = Pick<
  TopicCandidate,
  "articleType" | "formula" | "personaSlug" | "targetWords"
>;

// One candidate's fate, in input order - so callers (planAndEnqueue) can record
// a pipeline_ideas row per idea without re-matching by topic string. "unused"
// only occurs in slot-fill mode: the candidate arrived after its category's
// slots were all filled (it is the untouched ideation buffer).
export interface EnqueueOutcome {
  topic: string;
  status: "enqueued" | "dup" | "unused";
  queueId?: number;
  reason?: string;
  score?: number;
  matched?: string; // the prior post/topic it collided with
}

export interface EnqueueReport {
  inserted: { id: number; topic: string; normKey: string }[];
  skipped: { topic: string; reason: string; score?: number; matched?: string }[];
  outcomes: EnqueueOutcome[]; // one per input candidate, in order
}

// Load the dedup ledger: canonical keys + token sets from every queued topic AND
// every published post title, each paired with a human label (queued topic /
// post title) so a duplicate can report WHAT it collided with. Token sets are
// reconstructed from the stored key (already the sorted unique token list).
async function loadLedger(
  d: DB,
): Promise<{ keyLabels: Map<string, string>; priors: Prior[] }> {
  const [queued, published] = await Promise.all([
    d.select({ normKey: contentQueue.normKey, topic: contentQueue.topic }).from(contentQueue).all(),
    d.select({ title: posts.title }).from(posts).all(),
  ]);

  const keyLabels = new Map<string, string>();
  const priors: Prior[] = [];
  const add = (key: string, tokens: Set<string>, label: string) => {
    if (!key || keyLabels.has(key)) return;
    keyLabels.set(key, label);
    priors.push({ tokens, label });
  };

  for (const r of queued) add(r.normKey, new Set(r.normKey.split("-")), r.topic);
  for (const r of published) {
    const n = normalizeTopic(r.title);
    add(n.key, n.tokens, r.title);
  }
  return { keyLabels, priors };
}

// De-duplicate candidates against the ledger AND against each other, then insert
// the survivors. Returns which were kept, which were dropped (with reason + the
// prior it matched), and a per-candidate outcome list in input order.
//
// Slot-fill mode (opts.slots): planAndEnqueue passes ALL ideated topics per
// category, in LLM order, plus each category's planned style slots. A committed
// insert consumes the category's next slot; a duplicate does NOT - so the next
// surviving idea backfills it (this is what the "+2" ideation buffer is for).
// Candidates arriving after the slots are gone are recorded "unused" without
// touching the ledger. Without opts.slots (manual/admin enqueue) behaviour is
// unchanged: every non-duplicate is inserted with its own style fields.
export async function enqueueTopics(
  env: Bindings,
  candidates: TopicCandidate[],
  opts: { slots?: Map<string, SlotStyle[]> } = {},
): Promise<EnqueueReport> {
  const d = db(env.DB);
  const { keyLabels, priors } = await loadLedger(d);
  const report: EnqueueReport = { inserted: [], skipped: [], outcomes: [] };
  // Near-duplicate sensitivity is an ops knob (quality.similarityThreshold).
  const threshold = (await getConfig(env)).quality.similarityThreshold;

  for (const c of candidates) {
    const topic = cleanText(c.topic);
    const slotQueue = opts.slots?.get(c.categorySlug);
    if (slotQueue && slotQueue.length === 0) {
      report.outcomes.push({ topic, status: "unused" });
      continue;
    }
    const norm = normalizeTopic(topic || cleanText(c.titleHint));
    const verdict = isDuplicate(norm, keyLabels, priors, threshold);
    if (verdict.duplicate) {
      report.skipped.push({
        topic,
        reason: verdict.reason ?? "duplicate",
        score: verdict.score,
        matched: verdict.matched,
      });
      report.outcomes.push({
        topic,
        status: "dup",
        reason: verdict.reason ?? "duplicate",
        score: verdict.score,
        matched: verdict.matched,
      });
      continue;
    }

    // Style comes from the category's next open slot in slot-fill mode, from
    // the candidate itself otherwise.
    const style: SlotStyle = slotQueue ? slotQueue[0] : c;
    try {
      const rows = await d
        .insert(contentQueue)
        .values({
          topic,
          titleHint: cleanText(c.titleHint) || null,
          normKey: norm.key,
          keyword: cleanText(c.keyword) || null,
          categorySlug: c.categorySlug,
          articleType: style.articleType ?? null,
          formula: style.formula ?? null,
          personaSlug: style.personaSlug ?? null,
          targetWords: style.targetWords ?? null,
          priority: c.priority ?? 0,
          source: c.source ?? "llm-ideation",
          scheduledFor: c.scheduledFor ?? null,
        })
        .returning({ id: contentQueue.id });
      // Only claim the key (and consume the slot) once the row is committed
      // (else a failed insert would wrongly block a later, valid candidate
      // that shares the key - or burn a slot it never filled).
      keyLabels.set(norm.key, topic);
      priors.push({ tokens: norm.tokens, label: topic });
      slotQueue?.shift();
      report.inserted.push({ id: rows[0].id, topic, normKey: norm.key });
      report.outcomes.push({ topic, status: "enqueued", queueId: rows[0].id });
    } catch (err) {
      // UNIQUE(norm_key) backstop against a race with a concurrent enqueue.
      report.skipped.push({ topic, reason: "unique-conflict" });
      report.outcomes.push({ topic, status: "dup", reason: "unique-conflict" });
    }
  }
  return report;
}

// Pop the next `limit` pending items, highest priority then oldest first.
// (Category/style rotation is layered on top in task #5.)
export async function popPending(
  env: Bindings,
  limit: number,
): Promise<ContentQueueItem[]> {
  return db(env.DB)
    .select()
    .from(contentQueue)
    .where(eq(contentQueue.status, "pending"))
    .orderBy(desc(contentQueue.priority), asc(contentQueue.createdAt))
    .limit(limit)
    .all();
}

const now = () => new Date().toISOString();

export async function markGenerating(
  env: Bindings,
  id: number,
  runId?: string,
): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({
      status: "generating",
      attempts: sql`${contentQueue.attempts} + 1`,
      runId: runId ?? null,
      updatedAt: now(),
    })
    .where(eq(contentQueue.id, id));
}

export async function markPublished(
  env: Bindings,
  id: number,
  info: {
    postId: number;
    slug: string;
    coverPhotoId?: string | null;
    photoCredit?: string | null;
    qualityScore?: number | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = {
    status: "published",
    publishedPostId: info.postId,
    publishedSlug: info.slug,
    coverPhotoId: info.coverPhotoId ?? null,
    photoCredit: info.photoCredit ?? null,
    draftJson: null, // held draft (review mode) is no longer needed once live
    lastError: null,
    updatedAt: now(),
  };
  // Keep an existing critic score (set when the draft was held for review)
  // unless this publish carries its own.
  if (info.qualityScore != null) set.qualityScore = info.qualityScore;
  await db(env.DB).update(contentQueue).set(set).where(eq(contentQueue.id, id));
}

// Review mode (publish.mode = review): hold the finished draft instead of
// publishing. draft_json carries the HeldDraft shape the admin approve flow
// parses (see src/admin/pages-manage.tsx).
export async function markAwaitingReview(
  env: Bindings,
  id: number,
  draft: unknown,
  qualityScore?: number | null,
): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({
      status: "awaiting_review",
      draftJson: JSON.stringify(draft),
      qualityScore: qualityScore ?? null,
      lastError: null,
      updatedAt: now(),
    })
    .where(eq(contentQueue.id, id));
}

export async function markFailed(
  env: Bindings,
  id: number,
  error: string,
): Promise<void> {
  await db(env.DB)
    .update(contentQueue)
    .set({ status: "failed", lastError: error.slice(0, 500), updatedAt: now() })
    .where(eq(contentQueue.id, id));
}

// Photo ids already used on a cover, so the image fetcher (task #8) never repeats
// a photo across posts.
export async function usedPhotoIds(env: Bindings): Promise<Set<string>> {
  const rows = await db(env.DB)
    .select({ id: contentQueue.coverPhotoId })
    .from(contentQueue)
    .where(isNotNull(contentQueue.coverPhotoId))
    .all();
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

// Counts by status + per-category pending backlog (drives the orchestrator's
// round-robin balancing in task #5).
export async function queueStats(env: Bindings): Promise<{
  byStatus: Record<string, number>;
  pendingByCategory: Record<string, number>;
}> {
  const d = db(env.DB);
  const [statusRows, catRows] = await Promise.all([
    d
      .select({ status: contentQueue.status, n: sql<number>`count(*)` })
      .from(contentQueue)
      .groupBy(contentQueue.status)
      .all(),
    d
      .select({ cat: contentQueue.categorySlug, n: sql<number>`count(*)` })
      .from(contentQueue)
      .where(eq(contentQueue.status, "pending"))
      .groupBy(contentQueue.categorySlug)
      .all(),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;
  const pendingByCategory: Record<string, number> = {};
  for (const r of catRows) pendingByCategory[r.cat] = r.n;
  return { byStatus, pendingByCategory };
}
