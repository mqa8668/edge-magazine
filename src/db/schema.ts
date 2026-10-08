// Drizzle schema — D1 published projection.
// Mirrors tech-spec §5. SQLite types: TEXT / INTEGER / REAL, booleans as 0/1,
// timestamps as ISO-8601 TEXT. The FTS5 virtual table (posts_fts) is defined in
// migrations/0001_fts5.sql, not here (drizzle has no FTS5 support).

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// ── Authors ─────────────────────────────────────────────────────────────────
export const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  role: text("role"), // byline title, e.g. "Senior Editor, Productivity"
  shortBio: text("short_bio"), // one-liner for the author page hero
  bio: text("bio"), // long biography (About tab, article author card)
  location: text("location"),
  joined: text("joined"), // display string, e.g. "March 2023"
  twitter: text("twitter"), // handle, e.g. "@miatran"
  website: text("website"),
  expertise: text("expertise"), // JSON array of strings
  featuredIn: text("featured_in"), // JSON array of strings
  avatarKey: text("avatar_key"), // R2 key
  postCount: integer("post_count").notNull().default(0),
});

// ── Categories ──────────────────────────────────────────────────────────────
export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tagline: text("tagline"), // one-liner, e.g. "Work smarter, not harder."
  description: text("description"),
  position: integer("position").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  postCount: integer("post_count").notNull().default(0),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  ogImageKey: text("og_image_key"),
});

// ── Tags ────────────────────────────────────────────────────────────────────
export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  usageCount: integer("usage_count").notNull().default(0),
});

// Old tag slug -> canonical tag slug, written by the tag-merge backfill
// (scripts/merge-tags.mjs). The tag route 301s on a miss; publishPost remaps
// incoming tags through it so merged tags cannot be re-created by the LLM.
export const tagRedirects = sqliteTable("tag_redirects", {
  oldSlug: text("old_slug").primaryKey(),
  newSlug: text("new_slug").notNull(),
});

// ── Posts (published only) ──────────────────────────────────────────────────
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    authorId: integer("author_id").references(() => authors.id),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    processedHtml: text("processed_html").notNull(),
    readingTime: integer("reading_time"),
    wordCount: integer("word_count"),
    publishedAt: text("published_at").notNull(), // ISO-8601
    lastUpdatedAt: text("last_updated_at"),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    ogImageKey: text("og_image_key"),
    canonicalUrl: text("canonical_url"),
    coverImageKey: text("cover_image_key"),
    coverImageAlt: text("cover_image_alt"),
    coverFocalX: real("cover_focal_x").default(0.5),
    coverFocalY: real("cover_focal_y").default(0.5),
    coverBlurhash: text("cover_blurhash"),
    firstContentImageUrl: text("first_content_image_url"),
    isFeatured: integer("is_featured").notNull().default(0),
    isEvergreen: integer("is_evergreen").notNull().default(1),
    viewCount: integer("view_count").notNull().default(0),
    schemaJson: text("schema_json"),
    sourceDomain: text("source_domain"),
  },
  (t) => [
    index("idx_posts_category").on(t.categoryId, t.publishedAt),
    index("idx_posts_author").on(t.authorId, t.publishedAt),
    index("idx_posts_featured").on(t.isFeatured, t.publishedAt),
    index("idx_posts_popular").on(t.viewCount),
    index("idx_posts_published").on(t.publishedAt),
  ],
);

// ── Post <-> Tag join ───────────────────────────────────────────────────────
export const postsTags = sqliteTable(
  "posts_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.tagId] }),
    index("idx_posts_tags_tag").on(t.tagId),
  ],
);

// ── Topic clusters (hub-and-spoke) ──────────────────────────────────────────
export const topicClusters = sqliteTable("topic_clusters", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  pillarKeyword: text("pillar_keyword"),
  hubPostId: integer("hub_post_id").references(() => posts.id),
  isActive: integer("is_active").notNull().default(1),
  position: integer("position").notNull().default(0),
  introHtml: text("intro_html"), // LLM-generated pillar overview (migration 0013)
  updatedAt: text("updated_at"),
});

export const topicClusterSpokes = sqliteTable(
  "topic_cluster_spokes",
  {
    clusterId: integer("cluster_id")
      .notNull()
      .references(() => topicClusters.id, { onDelete: "cascade" }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.postId] })],
);

// ── Content queue + topic ledger (autonomous pipeline, migrations/0008) ──────
export const contentQueue = sqliteTable(
  "content_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    status: text("status", {
      enum: [
        "pending",
        "generating",
        "awaiting_review",
        "published",
        "failed",
        "skipped",
      ],
    })
      .notNull()
      .default("pending"),
    topic: text("topic").notNull(),
    titleHint: text("title_hint"),
    normKey: text("norm_key").notNull().unique(),
    keyword: text("keyword"),
    categorySlug: text("category_slug").notNull(),
    articleType: text("article_type"),
    formula: text("formula"),
    personaSlug: text("persona_slug"),
    targetWords: integer("target_words"),
    priority: integer("priority").notNull().default(0),
    source: text("source"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    coverPhotoId: text("cover_photo_id"),
    scheduledFor: text("scheduled_for"),
    publishedPostId: integer("published_post_id").references(() => posts.id),
    publishedSlug: text("published_slug"),
    runId: text("run_id"), // -> pipeline_runs.id (the run that produced this item)
    qualityScore: integer("quality_score"), // critic pass score (B5)
    photoCredit: text("photo_credit"), // stock photo attribution
    draftJson: text("draft_json"), // held draft for review mode (B5)
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at"),
  },
  (t) => [
    index("idx_queue_status_priority").on(t.status, t.priority, t.createdAt),
    index("idx_queue_category").on(t.categorySlug, t.status),
    index("idx_queue_photo").on(t.coverPhotoId),
  ],
);

// ── Pipeline runs (B2 telemetry) - one row per runBatch() invocation ─────────
export const pipelineRuns = sqliteTable(
  "pipeline_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger", { enum: ["cron", "manual", "backfill"] }).notNull(),
    status: text("status", {
      enum: ["running", "ok", "partial", "failed", "skipped"],
    }).notNull(),
    startedAt: integer("started_at").notNull(), // epoch ms
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
    requested: integer("requested"),
    ideated: integer("ideated"),
    enqueued: integer("enqueued"),
    skippedDup: integer("skipped_dup"),
    published: integer("published"),
    failed: integer("failed"),
    reportJson: text("report_json"),
    error: text("error"),
  },
  (t) => [
    index("idx_runs_started").on(t.startedAt),
    index("idx_runs_status").on(t.status, t.startedAt),
  ],
);

// ── LLM calls (B2 telemetry) - one row per provider attempt inside chat() ────
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id"),
    queueId: integer("queue_id"),
    stage: text("stage").notNull(), // ideation | draft | regen | critic | test | chat
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    ok: integer("ok").notNull(),
    error: text("error"),
    latencyMs: integer("latency_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costMicros: integer("cost_micros"), // USD * 1e6
    attempt: integer("attempt").notNull().default(1),
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [
    index("idx_llm_run").on(t.runId),
    index("idx_llm_created").on(t.createdAt),
  ],
);

// ── Config change audit (B1) ─────────────────────────────────────────────────
export const configAudit = sqliteTable(
  "config_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    changedAt: integer("changed_at").notNull(), // epoch ms
    actor: text("actor").notNull(),
    diffJson: text("diff_json").notNull(),
  },
  (t) => [index("idx_config_audit_changed").on(t.changedAt)],
);

// ── Pipeline ideas (observability) - one row per topic ideation produced, kept
//    whether it was enqueued, dropped as a duplicate, or safety-blocked. This is
//    what makes a run's planning stage auditable ("3 ideas -> 1 enqueued, 2 dup
//    of <title>"). Enqueued ideas also exist as content_queue rows; this table
//    additionally records the ones that never made it. ────────────────────────
export const pipelineIdeas = sqliteTable(
  "pipeline_ideas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(), // -> pipeline_runs.id
    categorySlug: text("category_slug").notNull(),
    topic: text("topic").notNull(),
    keyword: text("keyword"),
    // enqueued  = accepted into content_queue
    // dup       = dropped by the dedup ledger (see dupReason/dupScore/matchedTitle)
    // safety_blocked = dropped by the HARD safety layer before enqueue
    // unused    = LLM proposed it (ideation buffer) but no style slot needed it
    status: text("status", {
      enum: ["enqueued", "dup", "safety_blocked", "unused"],
    }).notNull(),
    dupReason: text("dup_reason"), // exact-key | similar | unique-conflict | empty-after-normalize
    dupScore: real("dup_score"), // best Jaccard overlap (0..1) when reason=similar
    matchedTitle: text("matched_title"), // the prior post/queued topic it collided with
    queueId: integer("queue_id"), // -> content_queue.id when status=enqueued
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (t) => [index("idx_ideas_run").on(t.runId)],
);

// ── Notifications (ops) - a persisted, in-app copy of every alert sendAlert
//    raises, plus a place for derived operational signals. Drives the topbar
//    bell (unread badge) and the /admin/alerts page. readAt null = unread. ────
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(), // matches AlertType, plus review-pending etc.
    severity: text("severity", { enum: ["info", "warn", "error"] }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"), // deep link, e.g. /admin/runs/<id>
    createdAt: integer("created_at").notNull(), // epoch ms
    readAt: integer("read_at"), // epoch ms; null = unread
  },
  (t) => [
    index("idx_notif_created").on(t.createdAt),
    index("idx_notif_unread").on(t.readAt),
  ],
);

// ── Newsletter subscribers (written at edge) ────────────────────────────────
export const subscribers = sqliteTable("subscribers", {
  id: integer("id").primaryKey(),
  email: text("email").notNull().unique(),
  status: text("status", { enum: ["pending", "confirmed", "unsubscribed"] })
    .notNull()
    .default("pending"),
  token: text("token").notNull(),
  source: text("source"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  confirmedAt: text("confirmed_at"),
});

export type Author = typeof authors.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type TopicCluster = typeof topicClusters.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type ContentQueueItem = typeof contentQueue.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;
export type ConfigAuditRow = typeof configAudit.$inferSelect;
export type PipelineIdea = typeof pipelineIdeas.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
