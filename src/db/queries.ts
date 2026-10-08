import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db, schema } from "./client";

const {
  posts,
  categories,
  authors,
  tags,
  tagRedirects,
  postsTags,
  topicClusters,
  topicClusterSpokes,
} = schema;

// Card-shaped row used by every list view (home, category, tag, author, related).
export interface PostCard {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  publishedAt: string;
  readingTime: number | null;
  coverImageKey: string | null;
  coverImageAlt: string | null;
  coverBlurhash: string | null;
  coverFocalX: number | null;
  coverFocalY: number | null;
  isFeatured: number;
  viewCount: number;
  categorySlug: string;
  categoryName: string;
  authorSlug: string | null;
  authorName: string | null;
  authorRole: string | null;
}

// Shared SELECT projection for cards (post + its category + author).
const cardColumns = {
  id: posts.id,
  slug: posts.slug,
  title: posts.title,
  excerpt: posts.excerpt,
  publishedAt: posts.publishedAt,
  readingTime: posts.readingTime,
  coverImageKey: posts.coverImageKey,
  coverImageAlt: posts.coverImageAlt,
  coverBlurhash: posts.coverBlurhash,
  coverFocalX: posts.coverFocalX,
  coverFocalY: posts.coverFocalY,
  isFeatured: posts.isFeatured,
  viewCount: posts.viewCount,
  categorySlug: categories.slug,
  categoryName: categories.name,
  authorSlug: authors.slug,
  authorName: authors.name,
  authorRole: authors.role,
} as const;

function cardQuery(d: ReturnType<typeof db>) {
  return d
    .select(cardColumns)
    .from(posts)
    .innerJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(authors, eq(posts.authorId, authors.id));
}

// ── Home ────────────────────────────────────────────────────────────────────
// featured: hero lead + 2 secondary + 4 editor's picks (7).
// popular:  Trending Now sidebar (6, by view count).
// recent:   pool for the paginated Latest grid (featured posts are excluded
//           in the route, so fetch enough to survive the dedupe).
export async function getHomeData(d: ReturnType<typeof db>) {
  const [featured, popular, recent] = await Promise.all([
    cardQuery(d)
      .where(eq(posts.isFeatured, 1))
      .orderBy(desc(posts.publishedAt))
      .limit(7),
    cardQuery(d).orderBy(desc(posts.viewCount)).limit(6),
    cardQuery(d).orderBy(desc(posts.publishedAt)).limit(31),
  ]);
  return { featured, popular, recent } as {
    featured: PostCard[];
    popular: PostCard[];
    recent: PostCard[];
  };
}

// ── Top-bar breaking ticker ───────────────────────────────────────────────────
// Latest published article, used by the top strip "MOI:" ticker (Layout). Returns
// enough to build a real /{categorySlug}/{postSlug} link.
export async function getBreakingPost(d: ReturnType<typeof db>) {
  const rows = await d
    .select({
      title: posts.title,
      slug: posts.slug,
      categorySlug: categories.slug,
    })
    .from(posts)
    .innerJoin(categories, eq(posts.categoryId, categories.id))
    .orderBy(desc(posts.publishedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ── Category ────────────────────────────────────────────────────────────────
export async function getActiveCategoryBySlug(
  d: ReturnType<typeof db>,
  slug: string,
) {
  const rows = await d
    .select()
    .from(categories)
    .where(and(eq(categories.slug, slug), eq(categories.isActive, 1)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPostsByCategory(
  d: ReturnType<typeof db>,
  categoryId: number,
  page: number,
  perPage = 12,
) {
  const offset = (page - 1) * perPage;
  const [items, totalRow] = await Promise.all([
    cardQuery(d)
      .where(eq(posts.categoryId, categoryId))
      .orderBy(desc(posts.publishedAt))
      .limit(perPage)
      .offset(offset),
    d
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.categoryId, categoryId)),
  ]);
  return { items: items as PostCard[], total: totalRow[0]?.n ?? 0 };
}

// ── Post (article) ──────────────────────────────────────────────────────────
export async function getPost(
  d: ReturnType<typeof db>,
  categorySlug: string,
  postSlug: string,
) {
  const rows = await d
    .select({
      post: posts,
      category: categories,
      author: authors,
    })
    .from(posts)
    .innerJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(authors, eq(posts.authorId, authors.id))
    .where(and(eq(posts.slug, postSlug), eq(categories.slug, categorySlug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPostTags(d: ReturnType<typeof db>, postId: number) {
  return d
    .select({ id: tags.id, slug: tags.slug, name: tags.name })
    .from(postsTags)
    .innerJoin(tags, eq(postsTags.tagId, tags.id))
    .where(eq(postsTags.postId, postId))
    .orderBy(tags.name);
}

// Related posts: most shared tags, fallback to same category (tech-spec §11.3).
export async function getRelatedPosts(
  d: ReturnType<typeof db>,
  postId: number,
  categoryId: number,
  limit = 6,
): Promise<PostCard[]> {
  const byTags = (await d
    .select({ ...cardColumns, overlap: sql<number>`count(${postsTags.tagId})` })
    .from(posts)
    .innerJoin(categories, eq(posts.categoryId, categories.id))
    .leftJoin(authors, eq(posts.authorId, authors.id))
    .innerJoin(postsTags, eq(postsTags.postId, posts.id))
    .where(
      and(
        ne(posts.id, postId),
        sql`${postsTags.tagId} IN (SELECT tag_id FROM posts_tags WHERE post_id = ${postId})`,
      ),
    )
    .groupBy(posts.id)
    .orderBy(sql`count(${postsTags.tagId}) DESC`, desc(posts.publishedAt))
    .limit(limit)) as Array<PostCard & { overlap: number }>;

  if (byTags.length >= limit) return byTags.map(stripOverlap);

  // Fallback: fill from same category, excluding what we already have.
  const have = new Set([postId, ...byTags.map((p) => p.id)]);
  const fill = (await cardQuery(d)
    .where(eq(posts.categoryId, categoryId))
    .orderBy(desc(posts.publishedAt))
    .limit(limit + have.size)) as PostCard[];

  const merged = [...byTags.map(stripOverlap)];
  for (const p of fill) {
    if (merged.length >= limit) break;
    if (!have.has(p.id)) {
      merged.push(p);
      have.add(p.id);
    }
  }
  return merged;
}

function stripOverlap(p: PostCard & { overlap?: number }): PostCard {
  const { overlap: _overlap, ...rest } = p;
  return rest;
}

// Sidebar "Trending" on article pages: most-viewed posts minus the current one.
export async function getPopularPosts(
  d: ReturnType<typeof db>,
  limit: number,
  excludeId?: number,
): Promise<PostCard[]> {
  const base = cardQuery(d);
  const q = excludeId === undefined ? base : base.where(ne(posts.id, excludeId));
  return q.orderBy(desc(posts.viewCount)).limit(limit) as Promise<PostCard[]>;
}

// ── Tag ─────────────────────────────────────────────────────────────────────
export async function getTagBySlug(d: ReturnType<typeof db>, slug: string) {
  const rows = await d
    .select()
    .from(tags)
    .where(eq(tags.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPostsByTag(
  d: ReturnType<typeof db>,
  tagId: number,
  page: number,
  perPage = 20,
) {
  const offset = (page - 1) * perPage;
  const [items, totalRow] = await Promise.all([
    cardQuery(d)
      .innerJoin(postsTags, eq(postsTags.postId, posts.id))
      .where(eq(postsTags.tagId, tagId))
      .orderBy(desc(posts.publishedAt))
      .limit(perPage)
      .offset(offset),
    d
      .select({ n: sql<number>`count(*)` })
      .from(postsTags)
      .where(eq(postsTags.tagId, tagId)),
  ]);
  return { items: items as PostCard[], total: totalRow[0]?.n ?? 0 };
}

// ── Author ──────────────────────────────────────────────────────────────────
export async function getAuthorBySlug(d: ReturnType<typeof db>, slug: string) {
  const rows = await d
    .select()
    .from(authors)
    .where(eq(authors.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPostsByAuthor(
  d: ReturnType<typeof db>,
  authorId: number,
  page: number,
  perPage = 20,
) {
  const offset = (page - 1) * perPage;
  const [items, totalRow] = await Promise.all([
    cardQuery(d)
      .where(eq(posts.authorId, authorId))
      .orderBy(desc(posts.publishedAt))
      .limit(perPage)
      .offset(offset),
    d
      .select({ n: sql<number>`count(*)` })
      .from(posts)
      .where(eq(posts.authorId, authorId)),
  ]);
  return { items: items as PostCard[], total: totalRow[0]?.n ?? 0 };
}

// ── Nav / footer (active categories) ────────────────────────────────────────
export async function getNavCategories(d: ReturnType<typeof db>) {
  return d
    .select({ slug: categories.slug, name: categories.name })
    .from(categories)
    .where(eq(categories.isActive, 1))
    .orderBy(categories.position, categories.name);
}

// Full active category rows ("Explore other topics" cards need tagline/counts).
export async function getActiveCategories(d: ReturnType<typeof db>) {
  return d
    .select()
    .from(categories)
    .where(eq(categories.isActive, 1))
    .orderBy(categories.position, categories.name);
}

// Authors who wrote in a category, with per-category article counts.
export interface Contributor {
  slug: string;
  name: string;
  role: string | null;
  count: number;
}

export async function getCategoryContributors(
  d: ReturnType<typeof db>,
  categoryId: number,
): Promise<Contributor[]> {
  return d
    .select({
      slug: authors.slug,
      name: authors.name,
      role: authors.role,
      count: sql<number>`count(*)`,
    })
    .from(posts)
    .innerJoin(authors, eq(posts.authorId, authors.id))
    .where(eq(posts.categoryId, categoryId))
    .groupBy(authors.id)
    .orderBy(sql`count(*) DESC`, authors.name) as Promise<Contributor[]>;
}

// Most-used tags within a category (filter tabs + "Popular tags").
export async function getCategoryTags(
  d: ReturnType<typeof db>,
  categoryId: number,
  limit = 8,
) {
  return d
    .select({
      slug: tags.slug,
      name: tags.name,
      count: sql<number>`count(*)`,
    })
    .from(postsTags)
    .innerJoin(posts, eq(postsTags.postId, posts.id))
    .innerJoin(tags, eq(postsTags.tagId, tags.id))
    .where(eq(posts.categoryId, categoryId))
    .groupBy(tags.id)
    .orderBy(sql`count(*) DESC`, tags.name)
    .limit(limit);
}

export async function getTopTags(d: ReturnType<typeof db>, limit = 8) {
  return d
    .select({ slug: tags.slug, name: tags.name })
    .from(tags)
    .orderBy(desc(tags.usageCount))
    .limit(limit);
}

// ── Search (FTS5) ───────────────────────────────────────────────────────────
// Tokenize the user query into quoted prefix terms so raw FTS5 syntax
// characters cannot break the MATCH expression.
function ftsMatchExpr(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(" ");
}

export async function searchPosts(
  d: ReturnType<typeof db>,
  q: string,
  limit = 50,
): Promise<PostCard[]> {
  const match = ftsMatchExpr(q);
  if (!match) return [];
  const rows = await d.all<{ id: number }>(
    sql`SELECT rowid AS id FROM posts_fts WHERE posts_fts MATCH ${match} ORDER BY rank LIMIT ${limit}`,
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const cards = (await cardQuery(d).where(inArray(posts.id, ids))) as PostCard[];
  const order = new Map(ids.map((id, i) => [id, i]));
  return cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// Distinct tags used by a set of posts ("Related" strip under search results).
export async function getTagsForPosts(
  d: ReturnType<typeof db>,
  postIds: number[],
  limit = 8,
) {
  if (postIds.length === 0) return [];
  return d
    .select({ slug: tags.slug, name: tags.name, count: sql<number>`count(*)` })
    .from(postsTags)
    .innerJoin(tags, eq(postsTags.tagId, tags.id))
    .where(inArray(postsTags.postId, postIds))
    .groupBy(tags.id)
    .orderBy(sql`count(*) DESC`, tags.name)
    .limit(limit);
}

// Tags that co-occur with the given tag on the same posts.
export async function getRelatedTags(
  d: ReturnType<typeof db>,
  tagId: number,
  limit = 4,
) {
  const pt2 = alias(postsTags, "pt2");
  return d
    .select({ slug: tags.slug, name: tags.name, count: sql<number>`count(*)` })
    .from(postsTags)
    .innerJoin(
      pt2,
      and(eq(pt2.postId, postsTags.postId), ne(pt2.tagId, postsTags.tagId)),
    )
    .innerJoin(tags, eq(tags.id, pt2.tagId))
    .where(eq(postsTags.tagId, tagId))
    .groupBy(tags.id)
    .orderBy(sql`count(*) DESC`, tags.name)
    .limit(limit);
}

// Full tag list with usage counts ("Browse all tags" cloud).
export async function getAllTagsWithCounts(d: ReturnType<typeof db>) {
  return d
    .select({
      slug: tags.slug,
      name: tags.name,
      usageCount: tags.usageCount,
    })
    .from(tags)
    .orderBy(desc(tags.usageCount), tags.name);
}

// Canonical tag vocabulary for the generation prompt: the most-used existing
// tag names, so the LLM reuses them instead of minting near-duplicates.
export async function getTagVocabulary(d: ReturnType<typeof db>, limit = 40) {
  const rows = await d
    .select({ name: tags.name })
    .from(tags)
    .where(sql`${tags.usageCount} > 0`)
    .orderBy(desc(tags.usageCount), tags.name)
    .limit(limit);
  return rows.map((r) => r.name);
}

// 301 target for a merged-away tag slug (null when none).
export async function getTagRedirect(
  d: ReturnType<typeof db>,
  oldSlug: string,
): Promise<string | null> {
  const row = await d
    .select({ newSlug: tagRedirects.newSlug })
    .from(tagRedirects)
    .where(eq(tagRedirects.oldSlug, oldSlug))
    .get();
  return row?.newSlug ?? null;
}

// Remap incoming tag slugs through tag_redirects onto their canonical tag
// {slug, name}. Slugs without a redirect pass through unchanged. Used by
// publishPost so the LLM cannot resurrect a merged-away tag.
export async function resolveTagRedirects(
  d: ReturnType<typeof db>,
  wanted: { name: string; slug: string }[],
): Promise<{ name: string; slug: string }[]> {
  if (wanted.length === 0) return wanted;
  const redirects = await d
    .select({
      oldSlug: tagRedirects.oldSlug,
      newSlug: tagRedirects.newSlug,
      newName: tags.name,
    })
    .from(tagRedirects)
    .innerJoin(tags, eq(tags.slug, tagRedirects.newSlug))
    .where(inArray(tagRedirects.oldSlug, wanted.map((t) => t.slug)))
    .all();
  if (redirects.length === 0) return wanted;
  const bySlug = new Map(redirects.map((r) => [r.oldSlug, r]));
  const out: { name: string; slug: string }[] = [];
  const seen = new Set<string>();
  for (const t of wanted) {
    const hit = bySlug.get(t.slug);
    const next = hit ? { name: hit.newName, slug: hit.newSlug } : t;
    if (seen.has(next.slug)) continue;
    seen.add(next.slug);
    out.push(next);
  }
  return out;
}

// ── Authors (all, for "Other authors" sidebar) ──────────────────────────────
export async function getAllAuthors(d: ReturnType<typeof db>) {
  return d.select().from(authors).orderBy(desc(authors.postCount), authors.name);
}

// ── Feeds / sitemaps ────────────────────────────────────────────────────────
export async function getRecentPostsForFeed(
  d: ReturnType<typeof db>,
  limit = 50,
): Promise<PostCard[]> {
  return cardQuery(d)
    .orderBy(desc(posts.publishedAt))
    .limit(limit) as Promise<PostCard[]>;
}

export interface SitemapPost {
  slug: string;
  title: string;
  categorySlug: string;
  publishedAt: string;
  lastUpdatedAt: string | null;
}

export async function getAllPostsForSitemap(
  d: ReturnType<typeof db>,
): Promise<SitemapPost[]> {
  return d
    .select({
      slug: posts.slug,
      title: posts.title,
      categorySlug: categories.slug,
      publishedAt: posts.publishedAt,
      lastUpdatedAt: posts.lastUpdatedAt,
    })
    .from(posts)
    .innerJoin(categories, eq(posts.categoryId, categories.id))
    .orderBy(desc(posts.publishedAt));
}

export async function getAllActiveCategoriesForSitemap(
  d: ReturnType<typeof db>,
) {
  return d
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.isActive, 1))
    .orderBy(categories.position);
}

// Authors that actually have >=1 published post, for the author sub-sitemap.
// Computed from the posts join (authoritative) rather than authors.post_count,
// which is a denormalized counter and was 0 for prod authors.
export async function getAllAuthorsForSitemap(d: ReturnType<typeof db>) {
  return d
    .selectDistinct({ slug: authors.slug })
    .from(authors)
    .innerJoin(posts, eq(posts.authorId, authors.id));
}

// ── Topic clusters (SEO phase 2b: hub-and-spoke pillar pages) ────────────────

export interface ClusterSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  spokeCount: number;
}

// Active clusters that actually have spokes, most-populated first (cluster index
// + footer/nav). A cluster with zero spokes is a stub, so it is hidden.
export async function listClusters(
  d: ReturnType<typeof db>,
): Promise<ClusterSummary[]> {
  return d
    .select({
      id: topicClusters.id,
      slug: topicClusters.slug,
      name: topicClusters.name,
      description: topicClusters.description,
      spokeCount: sql<number>`count(${topicClusterSpokes.postId})`,
    })
    .from(topicClusters)
    .innerJoin(topicClusterSpokes, eq(topicClusterSpokes.clusterId, topicClusters.id))
    .where(eq(topicClusters.isActive, 1))
    .groupBy(topicClusters.id)
    .orderBy(desc(sql`count(${topicClusterSpokes.postId})`), topicClusters.position)
    .all();
}

export async function getClusterBySlug(d: ReturnType<typeof db>, slug: string) {
  return d
    .select()
    .from(topicClusters)
    .where(and(eq(topicClusters.slug, slug), eq(topicClusters.isActive, 1)))
    .get();
}

// Spoke articles of a cluster as cards (newest first), optionally excluding one.
export async function getClusterSpokes(
  d: ReturnType<typeof db>,
  clusterId: number,
  opts: { limit?: number; excludePostId?: number } = {},
): Promise<PostCard[]> {
  const rows = (await cardQuery(d)
    .innerJoin(topicClusterSpokes, eq(topicClusterSpokes.postId, posts.id))
    .where(
      opts.excludePostId
        ? and(
            eq(topicClusterSpokes.clusterId, clusterId),
            ne(posts.id, opts.excludePostId),
          )
        : eq(topicClusterSpokes.clusterId, clusterId),
    )
    .orderBy(desc(posts.publishedAt))
    .limit(opts.limit ?? 50)) as PostCard[];
  return rows;
}

// The cluster a post belongs to (article "part of a series" badge + siblings).
export async function getPostCluster(d: ReturnType<typeof db>, postId: number) {
  return d
    .select({
      id: topicClusters.id,
      slug: topicClusters.slug,
      name: topicClusters.name,
    })
    .from(topicClusterSpokes)
    .innerJoin(topicClusters, eq(topicClusters.id, topicClusterSpokes.clusterId))
    .where(and(eq(topicClusterSpokes.postId, postId), eq(topicClusters.isActive, 1)))
    .get();
}

// "Read next" inside a cluster: the oldest sibling spoke published AFTER the
// current post, wrapping around to the cluster's oldest spoke when the current
// post is the newest. Excludes the post itself; null when the cluster has no
// other spoke (< 2 spokes total).
export async function getNextInCluster(
  d: ReturnType<typeof db>,
  clusterId: number,
  current: { id: number; publishedAt: string },
): Promise<PostCard | null> {
  const siblings = await getClusterSpokes(d, clusterId, {
    excludePostId: current.id,
  });
  if (siblings.length === 0) return null;
  const asc = [...siblings].reverse(); // getClusterSpokes returns newest-first
  return asc.find((p) => p.publishedAt > current.publishedAt) ?? asc[0];
}

export async function getAllClustersForSitemap(d: ReturnType<typeof db>) {
  return d
    .select({ slug: topicClusters.slug, updatedAt: topicClusters.updatedAt })
    .from(topicClusters)
    .innerJoin(topicClusterSpokes, eq(topicClusterSpokes.clusterId, topicClusters.id))
    .where(eq(topicClusters.isActive, 1))
    .groupBy(topicClusters.id)
    .all();
}
