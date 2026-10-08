// Topic clusters (SEO phase 2b): file each post into a narrow "topic cluster"
// so we can build hub-and-spoke pillar pages (/clusters/<slug>) - the structure
// that earns topical authority. Assignment is done by the LLM (provider order:
// cfg.seo.llmProviderOrder) because it reasons about MEANING, not keyword overlap.
//
// Best-effort: clustering must never break a publish, so everything is wrapped
// and failures are swallowed (the post is simply left unclustered).

import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { posts, topicClusters, topicClusterSpokes } from "../db/schema";
import type { Bindings } from "../env";
import type { RuntimeConfig } from "../lib/runtime-config";
import { cleanHtml, cleanText } from "../lib/sanitize";
import { slugify } from "../lib/slug";
import { chat, parseJsonObject } from "./llm";
import { log, errStr } from "../lib/log";

const now = () => new Date().toISOString();

interface ExistingCluster {
  id: number;
  slug: string;
  name: string;
  description: string | null;
}

// Classify a post into an existing cluster, or propose a new one when nothing
// fits and we are still under the ceiling. Returns null on any LLM/parse error.
async function classify(
  env: Bindings,
  cfg: RuntimeConfig,
  post: { title: string; excerpt: string | null; categorySlug: string; keyword?: string },
  existing: ExistingCluster[],
  allowNew: boolean,
): Promise<
  | { action: "existing"; slug: string }
  | { action: "new"; name: string; description: string; pillarKeyword: string }
  | null
> {
  const list = existing.length
    ? existing.map((c) => `- slug="${c.slug}" | ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n")
    : "(no clusters yet)";
  const system =
    'You are an SEO editor who groups articles into NARROW, clearly defined topic clusters used to build pillar pages. ' +
    'Each cluster is a specific sub-topic (for example "Deep work", "Morning routines", "Weekly planning"), narrower than a category.';
  const user = [
    `Article:`,
    `- Title: ${post.title}`,
    post.excerpt ? `- Summary: ${post.excerpt}` : "",
    `- Category: ${post.categorySlug}`,
    post.keyword ? `- Keyword: ${post.keyword}` : "",
    ``,
    `Existing clusters:`,
    list,
    ``,
    allowNew
      ? `If the article FITS an existing cluster, return: {"action":"existing","slug":"cluster-slug"}. If NO cluster truly fits, create a NARROW new one: {"action":"new","name":"Cluster name","description":"1 sentence describing the cluster scope","pillarKeyword":"main keyword"}. Write "name" and "description" in plain English.`
      : `Pick the BEST-FITTING cluster from the existing list. Return: {"action":"existing","slug":"cluster-slug"}.`,
    `Return ONLY one JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await chat(env, {
      system,
      user,
      json: true,
      temperature: 0.2,
      maxTokens: 200,
      providerOrder: cfg.seo.llmProviderOrder,
      track: { stage: "cluster-assign" },
    });
    const p = parseJsonObject<Record<string, unknown>>(res.text);
    const action = typeof p.action === "string" ? p.action : "";
    if (action === "existing" && typeof p.slug === "string" && p.slug.trim()) {
      return { action: "existing", slug: p.slug.trim() };
    }
    if (action === "new" && allowNew && typeof p.name === "string" && p.name.trim()) {
      return {
        action: "new",
        name: cleanText(p.name),
        description: cleanText(typeof p.description === "string" ? p.description : ""),
        pillarKeyword: cleanText(typeof p.pillarKeyword === "string" ? p.pillarKeyword : ""),
      };
    }
    return null;
  } catch (e) {
    log.warn("cluster.classify_failed", { err: errStr(e) });
    return null;
  }
}

// Sentence-case a cluster name so auto-generated names stay tidy (LLMs
// otherwise return Title Case: "Morning Habit Stacks" -> "Morning habit stacks").
function sentenceCase(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Resolve the LLM verdict to a concrete cluster (id + slug), creating the cluster
// (and its pillar intro) when the verdict is "new". Returns null if it cannot.
async function resolveCluster(
  env: Bindings,
  cfg: RuntimeConfig,
  verdict:
    | { action: "existing"; slug: string }
    | { action: "new"; name: string; description: string; pillarKeyword: string },
  existing: ExistingCluster[],
): Promise<{ id: number; slug: string } | null> {
  const d = db(env.DB);
  if (verdict.action === "existing") {
    const hit = existing.find((c) => c.slug === verdict.slug);
    if (hit) return { id: hit.id, slug: hit.slug };
    // LLM returned a slug we don't have -> fall through as if new is impossible.
    return null;
  }
  // New cluster: normalize casing, dedup on slug (reactivate a matching stub).
  const name = sentenceCase(verdict.name);
  const slug = slugify(name);
  if (!slug) return null;
  const found = await d
    .select({ id: topicClusters.id })
    .from(topicClusters)
    .where(eq(topicClusters.slug, slug))
    .get();
  if (found) {
    await d
      .update(topicClusters)
      .set({ isActive: 1, name, description: verdict.description || null })
      .where(eq(topicClusters.id, found.id));
    return { id: found.id, slug };
  }
  const inserted = await d
    .insert(topicClusters)
    .values({
      slug,
      name,
      description: verdict.description || null,
      pillarKeyword: verdict.pillarKeyword || null,
      isActive: 1,
      updatedAt: now(),
    })
    .returning({ id: topicClusters.id });
  const id = inserted[0].id;
  // Give a brand-new cluster a pillar overview right away (best-effort).
  await refreshPillarIntro(env, cfg, id);
  return { id, slug };
}

// Point a post at exactly one cluster (replace any prior membership).
async function setSpoke(env: Bindings, clusterId: number, postId: number): Promise<void> {
  const d = db(env.DB);
  await d.run(sql`DELETE FROM topic_cluster_spokes WHERE post_id = ${postId}`);
  await d.run(
    sql`INSERT OR IGNORE INTO topic_cluster_spokes (cluster_id, post_id) VALUES (${clusterId}, ${postId})`,
  );
}

// The public entry point: assign a freshly published post to a cluster.
export async function assignCluster(
  env: Bindings,
  cfg: RuntimeConfig,
  input: { postId: number; title: string; excerpt: string | null; categorySlug: string; keyword?: string },
): Promise<{ clusterId: number; slug: string } | null> {
  if (!cfg.seo.clustering.enabled) return null;
  try {
    const d = db(env.DB);
    const existing = (await d
      .select({
        id: topicClusters.id,
        slug: topicClusters.slug,
        name: topicClusters.name,
        description: topicClusters.description,
      })
      .from(topicClusters)
      .where(eq(topicClusters.isActive, 1))
      .all()) as ExistingCluster[];

    const allowNew = existing.length < cfg.seo.clustering.maxClusters;
    const verdict = await classify(env, cfg, input, existing.slice(0, 40), allowNew);
    if (!verdict) return null;

    const resolved = await resolveCluster(env, cfg, verdict, existing);
    if (!resolved) return null;

    await setSpoke(env, resolved.id, input.postId);
    log.info("cluster.assigned", { postId: input.postId, clusterId: resolved.id, action: verdict.action });
    return { clusterId: resolved.id, slug: resolved.slug };
  } catch (e) {
    log.warn("cluster.assign_failed", { postId: input.postId, err: errStr(e) });
    return null;
  }
}

// (Re)generate a cluster's pillar overview: a short, standalone topical intro
// (NOT an enumeration of articles, so it stays valid as spokes grow). Stored as
// intro_html on the cluster. Best-effort.
export async function refreshPillarIntro(
  env: Bindings,
  cfg: RuntimeConfig,
  clusterId: number,
): Promise<void> {
  try {
    const d = db(env.DB);
    const cluster = await d
      .select({
        name: topicClusters.name,
        description: topicClusters.description,
        pillarKeyword: topicClusters.pillarKeyword,
      })
      .from(topicClusters)
      .where(eq(topicClusters.id, clusterId))
      .get();
    if (!cluster) return;

    const spokeTitles = (
      await d
        .select({ title: posts.title })
        .from(topicClusterSpokes)
        .innerJoin(posts, eq(posts.id, topicClusterSpokes.postId))
        .where(eq(topicClusterSpokes.clusterId, clusterId))
        .limit(8)
        .all()
    ).map((r) => r.title);

    const system =
      'You are an editor writing the introduction for a topic page (pillar page): natural, useful, in a real person\'s voice. ' +
      'Do NOT use bullet lists of articles; write prose. Do NOT use em dashes, curly quotes, emoji or the ellipsis character (use "...").';
    const user = [
      `Write the introduction (2-3 short paragraphs, HTML using only <p>) for the topic page "${cluster.name}".`,
      cluster.description ? `Scope: ${cluster.description}` : "",
      cluster.pillarKeyword ? `Main keyword, to appear naturally: ${cluster.pillarKeyword}.` : "",
      spokeTitles.length ? `For reference on angles covered (do NOT list them back): ${spokeTitles.join("; ")}.` : "",
      `Goal: explain why this topic matters to the reader and what they will find here. No greeting, no "In conclusion". Return ONLY JSON: {"introHtml":"<p>...</p><p>...</p>"}`,
    ]
      .filter(Boolean)
      .join("\n");

    const res = await chat(env, {
      system,
      user,
      json: true,
      temperature: 0.7,
      maxTokens: 700,
      providerOrder: cfg.seo.llmProviderOrder,
      track: { stage: "pillar-intro" },
    });
    const parsed = parseJsonObject<{ introHtml?: unknown }>(res.text);
    const introHtml = cleanHtml(typeof parsed.introHtml === "string" ? parsed.introHtml : "");
    if (!introHtml) return;
    await d
      .update(topicClusters)
      .set({ introHtml, updatedAt: now() })
      .where(eq(topicClusters.id, clusterId));
    log.info("cluster.intro_refreshed", { clusterId });
  } catch (e) {
    log.warn("cluster.intro_failed", { clusterId, err: errStr(e) });
  }
}
