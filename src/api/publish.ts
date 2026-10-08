// Publish Worker - the single write path into the D1 published projection.
//
// Both the HTTP endpoint (src/api/index.ts) and the Phase 2 Cron orchestrator
// call publishPost(). It: validates + sanitizes, uploads images to R2, upserts
// the post row, syncs tags + join + usage counts, repopulates the FTS5 index,
// keeps category/author post_count accurate, and purges the affected caches.
//
// CONTENT RULE: every stored text field passes through cleanText/cleanHtml first
// (AGENTS.md). The sanitizer is diacritics-safe.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { authors, categories, posts, postsTags, tags } from "../db/schema";
import type { Bindings } from "../env";
import { cleanHtml, cleanText } from "../lib/sanitize";
import { resolveTagRedirects } from "../db/queries";
import { readingTimeFromText, stripHtml } from "../lib/html";
import { absUrl, routes, siteConfig } from "../lib/config";
import { purgeKvKeys, purgeUrls } from "../lib/cache";
import { submitPostToIndexNow } from "../seo/indexnow";
import { log, errStr } from "../lib/log";
import { isValidSlug, slugify } from "../lib/slug";
import type { PublishInput, PublishResult, PublishTag } from "./types";

// Typed failure the HTTP layer maps to a status code.
export class PublishError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

// KV payloads that go stale when any post changes (sitemap:pages + sitemap:news
// are not post-derived / not KV-cached, so they are left out).
export const STALE_KV_KEYS = [
  "sitemap:index",
  "sitemap:posts",
  "sitemap:categories",
  "sitemap:clusters",
  "sitemap:tags",
  "sitemap:authors",
  "feed:rss",
];

export async function publishPost(
  env: Bindings,
  input: PublishInput,
): Promise<PublishResult> {
  const d = db(env.DB);

  // ── 1. Validate ───────────────────────────────────────────────────────────
  const slug = (input.slug ?? "").trim();
  if (!slug) throw new PublishError(400, "slug is required");
  if (!isValidSlug(slug)) {
    throw new PublishError(
      400,
      `slug must be lowercase ascii words joined by hyphens (no diacritics): got "${slug}"`,
    );
  }
  if (!input.title?.trim()) throw new PublishError(400, "title is required");
  if (!input.bodyHtml?.trim()) throw new PublishError(400, "bodyHtml is required");
  if (!input.categorySlug?.trim()) {
    throw new PublishError(400, "categorySlug is required");
  }

  // ── 2. Resolve taxonomy ───────────────────────────────────────────────────
  const category = await d
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, input.categorySlug.trim()))
    .get();
  if (!category) {
    throw new PublishError(400, `unknown category: ${input.categorySlug}`);
  }

  let authorId: number | null = null;
  if (input.authorSlug?.trim()) {
    const author = await d
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.slug, input.authorSlug.trim()))
      .get();
    if (!author) throw new PublishError(400, `unknown author: ${input.authorSlug}`);
    authorId = author.id;
  }

  // ── 3. Upload images to R2 (before the row references them) ────────────────
  let imagesUploaded = 0;
  for (const img of input.images ?? []) {
    const key = img.key.replace(/^\/+/, "");
    if (!key) throw new PublishError(400, "image key is required");
    const body = img.bytes
      ? img.bytes
      : img.dataBase64
        ? base64ToBytes(img.dataBase64)
        : null;
    if (!body) throw new PublishError(400, `image ${key}: no bytes or dataBase64`);
    await env.UPLOADS.put(key, body, {
      httpMetadata: { contentType: img.contentType || "application/octet-stream" },
    });
    imagesUploaded++;
  }

  // ── 4. Sanitize + derive ──────────────────────────────────────────────────
  const title = cleanText(input.title);
  const excerpt = cleanText(input.excerpt) || null;
  const bodyHtml = cleanHtml(input.bodyHtml);
  const bodyText = stripHtml(bodyHtml);
  const wordCount =
    input.wordCount ?? bodyText.split(/\s+/).filter(Boolean).length;
  const readingTime = input.readingTime ?? readingTimeFromText(bodyText);
  const now = new Date().toISOString();

  // Columns shared by insert + update (never touch slug / id / view_count here).
  const row = {
    categoryId: category.id,
    authorId,
    title,
    excerpt,
    processedHtml: bodyHtml,
    readingTime,
    wordCount,
    metaTitle: cleanText(input.metaTitle) || null,
    metaDescription: cleanText(input.metaDescription) || null,
    ogImageKey: input.ogImageKey ?? null,
    canonicalUrl: input.canonicalUrl ?? null,
    coverImageKey: input.coverImageKey ?? null,
    coverImageAlt: cleanText(input.coverImageAlt) || null,
    coverFocalX: input.coverFocalX ?? 0.5,
    coverFocalY: input.coverFocalY ?? 0.5,
    coverBlurhash: input.coverBlurhash ?? null,
    firstContentImageUrl: input.firstContentImageUrl ?? null,
    isFeatured: input.isFeatured ? 1 : 0,
    isEvergreen: input.isEvergreen === false ? 0 : 1,
    schemaJson: input.schemaJson ?? null,
    sourceDomain: input.sourceDomain ?? null,
  };

  // ── 5. Upsert the post (fetch prior state first for create/update + FTS) ───
  const existing = await d
    .select({
      id: posts.id,
      categoryId: posts.categoryId,
      authorId: posts.authorId,
      title: posts.title,
      excerpt: posts.excerpt,
      processedHtml: posts.processedHtml,
    })
    .from(posts)
    .where(eq(posts.slug, slug))
    .get();

  let id: number;
  if (existing) {
    id = existing.id;
    await d
      .update(posts)
      .set({
        ...row,
        lastUpdatedAt: now,
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      })
      .where(eq(posts.id, id));
  } else {
    const inserted = await d
      .insert(posts)
      .values({
        slug,
        publishedAt: input.publishedAt ?? now,
        lastUpdatedAt: input.lastUpdatedAt ?? null,
        ...row,
      })
      .returning({ id: posts.id });
    id = inserted[0].id;
  }

  // ── 6. Tags: upsert, reset join, recompute usage counts ────────────────────
  // resolveTagRedirects remaps merged-away tags onto their canonical tag so a
  // regenerated old name cannot re-fragment the taxonomy. Best-effort: a
  // publish must never fail on the remap (e.g. tag_redirects not migrated yet).
  const normalizedTags = normalizeTags(input.tags);
  const wantTags = await resolveTagRedirects(d, normalizedTags).catch((e) => {
    log.warn("tags.redirect_remap_failed", { err: errStr(e) });
    return normalizedTags;
  });
  const tagIds: number[] = [];
  for (const t of wantTags) {
    await d.run(
      sql`INSERT INTO tags (slug, name) VALUES (${t.slug}, ${t.name})
          ON CONFLICT(slug) DO UPDATE SET name = excluded.name`,
    );
    const tag = await d
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.slug, t.slug))
      .get();
    if (tag) tagIds.push(tag.id);
  }

  const oldTagRows = await d
    .select({ tagId: postsTags.tagId })
    .from(postsTags)
    .where(eq(postsTags.postId, id))
    .all();
  const oldTagIds = oldTagRows.map((r) => r.tagId);

  await d.run(sql`DELETE FROM posts_tags WHERE post_id = ${id}`);
  for (const tid of tagIds) {
    await d.run(
      sql`INSERT INTO posts_tags (post_id, tag_id) VALUES (${id}, ${tid})`,
    );
  }
  for (const tid of new Set([...tagIds, ...oldTagIds])) {
    await d.run(
      sql`UPDATE tags SET usage_count =
            (SELECT COUNT(*) FROM posts_tags WHERE tag_id = ${tid})
          WHERE id = ${tid}`,
    );
  }

  // ── 7. FTS5: contentless index needs the OLD values to delete before insert ─
  if (existing) {
    await d.run(
      sql`INSERT INTO posts_fts (posts_fts, rowid, title, excerpt, body)
          VALUES ('delete', ${id}, ${existing.title}, ${existing.excerpt ?? ""},
                  ${stripHtml(existing.processedHtml)})`,
    );
  }
  await d.run(
    sql`INSERT INTO posts_fts (rowid, title, excerpt, body)
        VALUES (${id}, ${title}, ${excerpt ?? ""}, ${bodyText})`,
  );

  // ── 8. Keep post_count accurate (both old + new category/author on a move) ──
  const catIds = new Set<number>([category.id]);
  const authIds = new Set<number>(authorId ? [authorId] : []);
  if (existing) {
    catIds.add(existing.categoryId);
    if (existing.authorId) authIds.add(existing.authorId);
  }
  for (const cid of catIds) {
    await d.run(
      sql`UPDATE categories SET post_count =
            (SELECT COUNT(*) FROM posts WHERE category_id = ${cid})
          WHERE id = ${cid}`,
    );
  }
  for (const aid of authIds) {
    await d.run(
      sql`UPDATE authors SET post_count =
            (SELECT COUNT(*) FROM posts WHERE author_id = ${aid})
          WHERE id = ${aid}`,
    );
  }

  // ── 9. Purge caches for every URL this post appears on ─────────────────────
  const site = siteConfig(env);
  const paths = new Set<string>([
    routes.home(),
    routes.category(input.categorySlug.trim()),
    routes.post(input.categorySlug.trim(), slug),
    routes.search(),
  ]);
  if (input.authorSlug?.trim()) paths.add(routes.author(input.authorSlug.trim()));
  for (const t of wantTags) paths.add(routes.tag(t.slug));
  const purged = [...paths].map((p) => absUrl(site, p));
  await purgeUrls(purged);
  await purgeKvKeys(env, STALE_KV_KEYS);

  // ── 10. IndexNow ping (best-effort; instant Bing/Yandex/Seznam discovery) ───
  // Time-boxed + self-guarding, so a slow/failed submit never fails a publish.
  await submitPostToIndexNow(env, {
    categorySlug: input.categorySlug.trim(),
    slug,
  }).catch((e) => log.warn("indexnow.publish_hook_failed", { err: errStr(e) }));

  return {
    ok: true,
    id,
    slug,
    url: routes.post(input.categorySlug.trim(), slug),
    created: !existing,
    imagesUploaded,
    purged,
  };
}

// Remove a post from the published projection (the admin "unpublish"). The
// posts table only holds published content (tech-spec §5), so unpublish = a
// full projection delete: row + tag joins + FTS entry + recomputed counts +
// cache purge. The content_queue ledger row (topic, draft, photo id) survives,
// so history and dedup are unaffected. R2 images are kept (cheap, and other
// systems may still reference them).
export async function deletePost(
  env: Bindings,
  id: number,
): Promise<{ ok: true; slug: string }> {
  const d = db(env.DB);
  const existing = await d
    .select({
      id: posts.id,
      slug: posts.slug,
      categoryId: posts.categoryId,
      authorId: posts.authorId,
      title: posts.title,
      excerpt: posts.excerpt,
      processedHtml: posts.processedHtml,
    })
    .from(posts)
    .where(eq(posts.id, id))
    .get();
  if (!existing) throw new PublishError(404, `post ${id} not found`);

  const category = await d
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.id, existing.categoryId))
    .get();

  // Tag ids now, so usage counts can be recomputed after the join rows go.
  const tagRows = await d
    .select({ tagId: postsTags.tagId, slug: tags.slug })
    .from(postsTags)
    .innerJoin(tags, eq(tags.id, postsTags.tagId))
    .where(eq(postsTags.postId, id))
    .all();

  // FTS5 contentless index requires the OLD values to delete the entry.
  await d.run(
    sql`INSERT INTO posts_fts (posts_fts, rowid, title, excerpt, body)
        VALUES ('delete', ${id}, ${existing.title}, ${existing.excerpt ?? ""},
                ${stripHtml(existing.processedHtml)})`,
  );

  // Release the FK from the queue ledger (keep published_slug for history).
  await d.run(
    sql`UPDATE content_queue SET published_post_id = NULL
        WHERE published_post_id = ${id}`,
  );
  await d.run(sql`DELETE FROM posts_tags WHERE post_id = ${id}`);
  await d.run(sql`DELETE FROM posts WHERE id = ${id}`);

  for (const t of tagRows) {
    await d.run(
      sql`UPDATE tags SET usage_count =
            (SELECT COUNT(*) FROM posts_tags WHERE tag_id = ${t.tagId})
          WHERE id = ${t.tagId}`,
    );
  }
  await d.run(
    sql`UPDATE categories SET post_count =
          (SELECT COUNT(*) FROM posts WHERE category_id = ${existing.categoryId})
        WHERE id = ${existing.categoryId}`,
  );
  if (existing.authorId) {
    await d.run(
      sql`UPDATE authors SET post_count =
            (SELECT COUNT(*) FROM posts WHERE author_id = ${existing.authorId})
          WHERE id = ${existing.authorId}`,
    );
  }

  const site = siteConfig(env);
  const paths = new Set<string>([routes.home(), routes.search()]);
  if (category) {
    paths.add(routes.category(category.slug));
    paths.add(routes.post(category.slug, existing.slug));
  }
  for (const t of tagRows) paths.add(routes.tag(t.slug));
  await purgeUrls([...paths].map((p) => absUrl(site, p)));
  await purgeKvKeys(env, STALE_KV_KEYS);

  return { ok: true, slug: existing.slug };
}

// Rebuild the entire FTS5 index from the posts table. Run once after an FTS
// schema/tokenizer migration (e.g. 0006), or any time the index drifts. Safe to
// re-run: 'delete-all' clears the contentless index before repopulating.
export async function reindexFts(env: Bindings): Promise<{ indexed: number }> {
  const d = db(env.DB);
  await d.run(sql`INSERT INTO posts_fts (posts_fts) VALUES ('delete-all')`);
  const rows = await d
    .select({
      id: posts.id,
      title: posts.title,
      excerpt: posts.excerpt,
      processedHtml: posts.processedHtml,
    })
    .from(posts)
    .all();
  for (const r of rows) {
    await d.run(
      sql`INSERT INTO posts_fts (rowid, title, excerpt, body)
          VALUES (${r.id}, ${r.title}, ${r.excerpt ?? ""}, ${stripHtml(r.processedHtml)})`,
    );
  }
  return { indexed: rows.length };
}

// Normalize a mixed list of tag names/objects into unique {name, slug} pairs.
function normalizeTags(
  input: (string | PublishTag)[] | undefined,
): { name: string; slug: string }[] {
  const out: { name: string; slug: string }[] = [];
  const seen = new Set<string>();
  for (const raw of input ?? []) {
    const name = cleanText(typeof raw === "string" ? raw : raw.name);
    if (!name) continue;
    const slug = slugify(
      typeof raw === "string" ? raw : (raw.slug ?? raw.name),
    );
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug });
  }
  return out;
}

// base64 (optionally a data: URL) -> bytes, for R2 uploads.
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
