-- Initial schema: relational tables, pipeline/telemetry tables and notifications.
CREATE TABLE `authors` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`bio` text,
	`avatar_key` text,
	`post_count` integer DEFAULT 0 NOT NULL,
	`role` text,
	`short_bio` text,
	`location` text,
	`joined` text,
	`twitter` text,
	`website` text,
	`expertise` text,
	`featured_in` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_slug_unique` ON `authors` (`slug`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`post_count` integer DEFAULT 0 NOT NULL,
	`meta_title` text,
	`meta_description` text,
	`og_image_key` text,
	`tagline` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`category_id` integer NOT NULL,
	`author_id` integer,
	`title` text NOT NULL,
	`excerpt` text,
	`processed_html` text NOT NULL,
	`reading_time` integer,
	`word_count` integer,
	`published_at` text NOT NULL,
	`last_updated_at` text,
	`meta_title` text,
	`meta_description` text,
	`og_image_key` text,
	`canonical_url` text,
	`cover_image_key` text,
	`cover_image_alt` text,
	`cover_focal_x` real DEFAULT 0.5,
	`cover_focal_y` real DEFAULT 0.5,
	`cover_blurhash` text,
	`first_content_image_url` text,
	`is_featured` integer DEFAULT 0 NOT NULL,
	`is_evergreen` integer DEFAULT 1 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`schema_json` text,
	`source_domain` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_slug_unique` ON `posts` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_posts_category` ON `posts` (`category_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_author` ON `posts` (`author_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_featured` ON `posts` (`is_featured`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_popular` ON `posts` (`view_count`);--> statement-breakpoint
CREATE INDEX `idx_posts_published` ON `posts` (`published_at`);--> statement-breakpoint
CREATE TABLE `posts_tags` (
	`post_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`post_id`, `tag_id`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_posts_tags_tag` ON `posts_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token` text NOT NULL,
	`source` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`confirmed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`description` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);--> statement-breakpoint
CREATE TABLE `topic_cluster_spokes` (
	`cluster_id` integer NOT NULL,
	`post_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`cluster_id`, `post_id`),
	FOREIGN KEY (`cluster_id`) REFERENCES `topic_clusters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `topic_clusters` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pillar_keyword` text,
	`hub_post_id` integer,
	`is_active` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`intro_html` text,
	`updated_at` text,
	FOREIGN KEY (`hub_post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topic_clusters_slug_unique` ON `topic_clusters` (`slug`);
--> statement-breakpoint

-- from 0008_content_queue.sql
-- Content queue + topic ledger for the autonomous pipeline (one table, two jobs):
--   * forward QUEUE: rows the daily generator pops (status = 'pending').
--   * historical LEDGER: every topic ever proposed stays, so ideation never
--     re-suggests a covered/queued topic (dedup source of truth).
--
-- norm_key is a canonical, diacritic-folded, stopword-stripped, sorted-token key
-- (src/pipeline/normalize.ts); UNIQUE makes exact/reordered duplicates impossible
-- at the DB level. Near-duplicates are caught in code via token-overlap (Jaccard).
-- This table is prod infrastructure (the Cron reads/writes it), hence a migration.

CREATE TABLE content_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|generating|published|failed|skipped
  topic         TEXT NOT NULL,                   -- the human angle/brief
  title_hint    TEXT,                            -- optional suggested title (final comes from generation)
  norm_key      TEXT NOT NULL UNIQUE,            -- dedup key
  keyword       TEXT,                            -- primary SEO keyword/phrase
  category_slug TEXT NOT NULL,                   -- a category slug
  article_type  TEXT,                            -- how-to|listicle|storytelling|...
  formula       TEXT,                            -- writing formula: pas|aida|bab|...
  persona_slug  TEXT,                            -- author voice: author persona slug
  target_words  INTEGER,                         -- length target
  priority      INTEGER NOT NULL DEFAULT 0,      -- higher pops sooner
  source        TEXT,                            -- llm-ideation|manual|cluster-expansion
  attempts      INTEGER NOT NULL DEFAULT 0,      -- generation attempts (retry cap)
  last_error    TEXT,
  cover_photo_id     TEXT,                        -- stock photo id used (image dedup)
  scheduled_for      TEXT,                        -- ISO date to publish (backfill backdating)
  published_post_id  INTEGER REFERENCES posts(id),
  published_slug     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT,
  run_id        TEXT,                            -- -> pipeline_runs.id
  quality_score INTEGER,
  photo_credit  TEXT,
  draft_json    TEXT                             -- draft held for review mode
);

CREATE INDEX idx_queue_status_priority ON content_queue(status, priority, created_at);
CREATE INDEX idx_queue_category ON content_queue(category_slug, status);
CREATE INDEX idx_queue_photo ON content_queue(cover_photo_id);

-- from 0011_config_audit.sql
-- Runtime config change log (B1). The effective operating config lives in KV
-- (key cfg:v1, see src/lib/runtime-config.ts); every admin change also appends a
-- diff row here so config drift is auditable. actor is 'admin' or 'system';
-- diff_json is { "dotted.key": { "from": <old>, "to": <new> } }.

CREATE TABLE config_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at INTEGER NOT NULL,      -- epoch ms
  actor      TEXT NOT NULL,
  diff_json  TEXT NOT NULL
);

CREATE INDEX idx_config_audit_changed ON config_audit(changed_at);

-- from 0012_pipeline_telemetry.sql
-- Pipeline observability (B2). Two new tables record what the autonomous run did
-- and every LLM call it made, plus a few content_queue columns for run linkage,
-- review mode (B5), and photo credit. Timestamps are epoch ms (INTEGER) here to
-- keep age math cheap; content_queue keeps its existing ISO-8601 TEXT stamps.

-- One row per runBatch() invocation (cron / manual / backfill). report_json holds
-- the full RunReport (per-item outcomes); status is running|ok|partial|failed|skipped.
CREATE TABLE pipeline_runs (
  id          TEXT PRIMARY KEY,       -- crypto.randomUUID()
  trigger     TEXT NOT NULL,          -- cron | manual | backfill
  status      TEXT NOT NULL,          -- running | ok | partial | failed | skipped
  started_at  INTEGER NOT NULL,       -- epoch ms
  finished_at INTEGER,
  duration_ms INTEGER,
  requested   INTEGER,
  ideated     INTEGER,
  enqueued    INTEGER,
  skipped_dup INTEGER,
  published   INTEGER,
  failed      INTEGER,
  report_json TEXT,
  error       TEXT
);
CREATE INDEX idx_runs_started ON pipeline_runs(started_at DESC);
CREATE INDEX idx_runs_status ON pipeline_runs(status, started_at DESC);

-- One row per provider attempt inside chat() (both success and failure), so cost
-- and latency are attributable per run / queue item / stage.
CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT,             -- -> pipeline_runs.id (null for ad-hoc/test)
  queue_id          INTEGER,          -- -> content_queue.id (null for ideation)
  stage             TEXT NOT NULL,    -- ideation | draft | regen | critic | test | chat
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  ok                INTEGER NOT NULL, -- 1/0
  error             TEXT,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_micros       INTEGER,          -- USD * 1e6 (0 when pricing unknown)
  attempt           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL  -- epoch ms
);
CREATE INDEX idx_llm_run ON llm_calls(run_id);
CREATE INDEX idx_llm_created ON llm_calls(created_at DESC);


-- from 0014_ideas_notifications.sql
-- Pipeline observability round 2: make the planning stage auditable (every idea,
-- kept or dropped) and give the admin a real notification feed for the topbar
-- bell + /admin/alerts. Timestamps are epoch ms (INTEGER), matching the other
-- telemetry tables (pipeline_runs / llm_calls).

-- One row per ideated topic, whether it was enqueued, deduped, or safety-blocked.
-- Enqueued ideas also exist as content_queue rows (queue_id links them); the
-- dropped ones live only here, so a run's ideation -> enqueue funnel is explainable.
CREATE TABLE pipeline_ideas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,           -- -> pipeline_runs.id
  category_slug TEXT NOT NULL,
  topic         TEXT NOT NULL,
  keyword       TEXT,
  status        TEXT NOT NULL,           -- enqueued | dup | safety_blocked | unused
  dup_reason    TEXT,                    -- exact-key | similar | unique-conflict | empty-after-normalize
  dup_score     REAL,                    -- best Jaccard overlap (0..1) when reason=similar
  matched_title TEXT,                    -- prior post/queued topic it collided with
  queue_id      INTEGER,                 -- -> content_queue.id when status=enqueued
  created_at    INTEGER NOT NULL         -- epoch ms
);
CREATE INDEX idx_ideas_run ON pipeline_ideas(run_id);

-- In-app notification feed. sendAlert writes a row here (in addition to
-- email/telegram); the topbar bell shows the unread count and /admin/alerts
-- lists them. read_at null = unread.
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,              -- run-crashed | empty-run | high-fail-rate | stale-run | budget-exceeded | provider-down | review-pending
  severity   TEXT NOT NULL,              -- info | warn | error
  title      TEXT NOT NULL,
  body       TEXT,
  href       TEXT,                       -- deep link, e.g. /admin/runs/<id>
  created_at INTEGER NOT NULL,           -- epoch ms
  read_at    INTEGER                     -- epoch ms; null = unread
);
CREATE INDEX idx_notif_created ON notifications(created_at DESC);
CREATE INDEX idx_notif_unread ON notifications(read_at);

-- from 0015_tag_redirects.sql
-- Tag consolidation support: when near-duplicate tags are merged (see
-- scripts/merge-tags.mjs), the old slug 301-redirects to the canonical tag so
-- indexed/linked URLs keep working. publishPost also consults this table to
-- remap LLM-regenerated old tag names onto their canonical tag.
CREATE TABLE IF NOT EXISTS tag_redirects (
  old_slug TEXT PRIMARY KEY,
  new_slug TEXT NOT NULL
);

