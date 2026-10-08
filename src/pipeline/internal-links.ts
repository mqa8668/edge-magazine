// In-body internal linking (SEO phase 2a). Instead of mechanically wrapping
// every keyword occurrence - which reads like a link farm - we let the LLM
// choose 2-3 spots where a link genuinely helps the reader, using anchor text
// that ALREADY exists in the prose. The LLM provider order is
// cfg.seo.llmProviderOrder; these are short calls, so a small model is enough.
//
// Every step is best-effort: internal linking must NEVER break a publish, so any
// error returns the original body unchanged.

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import { categories, posts } from "../db/schema";
import type { Bindings } from "../env";
import type { RuntimeConfig } from "../lib/runtime-config";
import { stripHtml } from "../lib/html";
import { chat, parseJsonObject } from "./llm";
import { log, errStr } from "../lib/log";

export interface LinkCandidate {
  id: number;
  slug: string;
  categorySlug: string;
  title: string;
}

export interface AddLinksResult {
  bodyHtml: string;
  added: number;
  candidates: number;
}

// FTS MATCH expression that is injection-safe (mirrors queries.ts): prefix-match
// each of the first 8 tokens.
function ftsMatch(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(" ");
}

// Related published posts to link to: FTS hits on the keyword/title first, then
// same-category recency as a filler, deduped, excluding the article itself.
export async function findCandidates(
  env: Bindings,
  input: { categorySlug: string; keyword?: string; title: string; excludeSlug?: string },
  pool: number,
): Promise<LinkCandidate[]> {
  const d = db(env.DB);
  const q = [input.keyword, input.title].filter(Boolean).join(" ");
  const match = ftsMatch(q);

  let ftsIds: number[] = [];
  if (match) {
    const rows = await d.all<{ id: number }>(
      sql`SELECT rowid AS id FROM posts_fts WHERE posts_fts MATCH ${match} ORDER BY rank LIMIT ${pool}`,
    );
    ftsIds = rows.map((r) => r.id);
  }

  const base = d
    .select({
      id: posts.id,
      slug: posts.slug,
      categorySlug: categories.slug,
      title: posts.title,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .innerJoin(categories, eq(categories.id, posts.categoryId));

  const where = ftsIds.length
    ? sql`(${posts.id} IN (${sql.join(ftsIds, sql`, `)}) OR ${categories.slug} = ${input.categorySlug})`
    : eq(categories.slug, input.categorySlug);

  const rows = await base
    .where(
      input.excludeSlug ? and(where, ne(posts.slug, input.excludeSlug)) : where,
    )
    .orderBy(desc(posts.publishedAt))
    .limit(pool * 2)
    .all();

  // Rank: FTS hits (by rank order) first, then category fillers; cap at pool.
  const rank = new Map(ftsIds.map((id, i) => [id, i]));
  const seen = new Set<number>();
  const out: LinkCandidate[] = [];
  for (const r of rows.sort(
    (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9),
  )) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, slug: r.slug, categorySlug: r.categorySlug, title: r.title });
    if (out.length >= pool) break;
  }
  return out;
}

// Ask the LLM (free-first) which candidates to link, and with what natural anchor
// phrase copied verbatim from the body. Returns validated {anchor, slug} pairs.
async function selectLinks(
  env: Bindings,
  cfg: RuntimeConfig,
  input: { bodyText: string; title: string },
  candidates: LinkCandidate[],
  maxLinks: number,
): Promise<{ anchor: string; slug: string }[]> {
  const list = candidates
    .map((c, i) => `${i + 1}. slug="${c.slug}" | ${c.title}`)
    .join("\n");
  const system =
    'You are an SEO editor who adds natural INTERNAL LINKS. ' +
    'You only pick phrases that ALREADY EXIST VERBATIM in the article body as anchors, pointing to related articles so readers can go deeper. ' +
    'Never force a link, never spam, never invent new phrases.';
  const user = [
    `Body text of the article "${input.title}":`,
    '"""',
    input.bodyText.slice(0, 6000),
    '"""',
    `Articles you can link to (choose by exact slug):`,
    list,
    `Choose at most ${maxLinks} internal links. RULES:`,
    `- "anchor" MUST be a phrase that appears VERBATIM in the body above (copy it exactly, 2-6 words, a noun phrase or concept, NOT a whole sentence, NOT inside a heading).`,
    `- Each link points to a DIFFERENT article, and only when it is genuinely related and helps the reader.`,
    `- If no place is a real fit, return an empty array.`,
    `Return ONLY JSON: {"links":[{"anchor":"phrase from the body","slug":"target-article-slug"}]}`,
  ].join("\n");

  const res = await chat(env, {
    system,
    user,
    json: true,
    temperature: 0.3,
    maxTokens: 500,
    providerOrder: cfg.seo.llmProviderOrder,
    track: { stage: "internal-link" },
  });
  const parsed = parseJsonObject<{ links?: unknown }>(res.text);
  const raw = Array.isArray(parsed.links) ? parsed.links : [];
  const slugs = new Set(candidates.map((c) => c.slug));
  const out: { anchor: string; slug: string }[] = [];
  const usedSlugs = new Set<string>();
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    const anchor = typeof o.anchor === "string" ? o.anchor.trim() : "";
    const slug = typeof o.slug === "string" ? o.slug.trim() : "";
    // Validate: known slug, not yet used, and the anchor really is in the body.
    if (!anchor || anchor.length < 3 || !slugs.has(slug) || usedSlugs.has(slug)) continue;
    if (!input.bodyText.includes(anchor)) continue;
    usedSlugs.add(slug);
    out.push({ anchor, slug });
    if (out.length >= maxLinks) break;
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Insert the chosen links into the HTML, safely: only inside visible text (never
// inside a tag), never inside an existing <a> or a heading, and only the FIRST
// occurrence of each anchor. Anchors spanning an inline tag boundary are skipped.
export function insertLinks(
  bodyHtml: string,
  links: { anchor: string; href: string }[],
  maxLinks: number,
): { html: string; added: number } {
  const pending = links.slice();
  let added = 0;
  let inAnchor = false;
  let headingDepth = 0;
  const tokenRe = /(<[^>]+>)|([^<]+)/g;
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(bodyHtml)) !== null) {
    const tag = m[1];
    const textSeg = m[2];
    if (tag) {
      const t = tag.toLowerCase();
      if (/^<a[\s>]/.test(t)) inAnchor = true;
      else if (/^<\/a>/.test(t)) inAnchor = false;
      else if (/^<h[1-6][\s>]/.test(t)) headingDepth++;
      else if (/^<\/h[1-6]>/.test(t)) headingDepth = Math.max(0, headingDepth - 1);
      out += tag;
      continue;
    }
    let seg = textSeg ?? "";
    if (!inAnchor && headingDepth === 0 && added < maxLinks) {
      for (let i = 0; i < pending.length && added < maxLinks; i++) {
        const link = pending[i];
        const re = new RegExp(escapeRegex(link.anchor));
        const hit = re.exec(seg);
        if (!hit) continue;
        const before = seg.slice(0, hit.index);
        const after = seg.slice(hit.index + link.anchor.length);
        seg =
          before +
          `<a href="${escapeAttr(link.href)}" class="in-link">${link.anchor}</a>` +
          after;
        pending.splice(i, 1);
        added++;
        break; // one insertion per text segment keeps offsets simple
      }
    }
    out += seg;
  }
  return { html: out, added };
}

// Orchestrator: find candidates, ask the LLM for natural anchors, insert. Called
// from the publish path with the DRAFT body (candidates are already-published
// posts). Best-effort: any failure returns the body unchanged.
export async function addInternalLinks(
  env: Bindings,
  cfg: RuntimeConfig,
  input: { title: string; keyword?: string; categorySlug: string; bodyHtml: string; excludeSlug?: string },
): Promise<AddLinksResult> {
  const unchanged: AddLinksResult = { bodyHtml: input.bodyHtml, added: 0, candidates: 0 };
  if (!cfg.seo.internalLinking.enabled) return unchanged;
  try {
    const candidates = await findCandidates(
      env,
      { categorySlug: input.categorySlug, keyword: input.keyword, title: input.title, excludeSlug: input.excludeSlug },
      cfg.seo.internalLinking.candidatePool,
    );
    // Need a real corpus to link into; below that it is not worth an LLM call.
    if (candidates.length < 2) return { ...unchanged, candidates: candidates.length };

    const bodyText = stripHtml(input.bodyHtml);
    const chosen = await selectLinks(
      env,
      cfg,
      { bodyText, title: input.title },
      candidates,
      cfg.seo.internalLinking.maxLinks,
    );
    if (!chosen.length) return { ...unchanged, candidates: candidates.length };

    const urlBySlug = new Map(
      candidates.map((c) => [c.slug, `/${c.categorySlug}/${c.slug}`]),
    );
    const withHref = chosen
      .map((l) => ({ anchor: l.anchor, href: urlBySlug.get(l.slug) ?? "" }))
      .filter((l) => l.href);
    const { html, added } = insertLinks(
      input.bodyHtml,
      withHref,
      cfg.seo.internalLinking.maxLinks,
    );
    log.info("internal_link.done", { candidates: candidates.length, chosen: chosen.length, added });
    return { bodyHtml: html, added, candidates: candidates.length };
  } catch (e) {
    log.warn("internal_link.failed", { err: errStr(e) });
    return unchanged;
  }
}
