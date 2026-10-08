// Automated quality gate for a generated draft - it replaces the human reviewer
// under full autonomy. Hard errors trigger a regenerate (loop lives in the
// orchestrator); warnings are logged but allowed. Rules encode the anti-AI-tell
// craft: no essay openers, no textbook closers, no saturated hooks, no doom
// clickbait, no repeated paragraphs.

import { stripHtml } from "../lib/html";
import { foldAscii } from "../lib/slug";
import { findAiTell } from "../lib/sanitize";

export interface Draft {
  title: string;
  excerpt: string;
  bodyHtml: string;
  metaTitle?: string;
  metaDescription?: string;
  tags?: string[];
}

export interface ValidateOptions {
  targetWords: number;
  minWords?: number;
  maxWords?: number;
}

// Every way a draft can fail, as a stable code. The code is what lets the
// generate loop REPAIR the offending part instead of re-rolling the whole
// article: "body.too_short" expands the thinnest section, "body.closer"
// rewrites only the ending, "body.dup_para" needs no LLM call at all. Before
// these existed the loop treated every failure the same way - regenerate from
// scratch - which telemetry showed moved length by 3.7% over 52 calls.
export type IssueCode =
  | "title.empty"
  | "title.short"
  | "title.hook"
  | "title.metaphor"
  | "title.opener"
  | "title.localizer" // redundant audience tag ("for our readers")
  | "excerpt.empty"
  | "body.empty"
  | "body.h2"
  | "body.paragraphs"
  | "body.forbidden_tag"
  | "body.on_attr"
  | "body.too_short"
  | "body.opener"
  | "body.closer"
  | "body.hook"
  | "body.localizer"
  | "body.dup_para";

export interface Issue {
  code: IssueCode;
  message: string; // English, for logs / content_queue.last_error
  fix: string; // English instruction handed to the LLM repair call
}

export interface Verdict {
  ok: boolean;
  issues: Issue[];
  errors: string[]; // issues.map(i => i.message) - kept for logs/last_error
  warnings: string[];
  stats: { words: number; h2: number; paragraphs: number };
}

// ── Rule lists ───────────────────────────────────────────────────────────────
// Matching runs on foldAscii(text): lowercased, diacritics stripped, punctuation
// collapsed to single spaces, and compared on WORD boundaries. So "In today's
// fast-paced world" and "in todays fast paced world" are the same phrase, and
// curly vs straight apostrophes do not matter. Each list entry is written in
// natural English and folded once at load.

// Openers that read as machine-generated essay intros or greetings (matched at
// the start of the first paragraph).
const BANNED_OPENERS = [
  "in today's fast-paced world",
  "in today's digital age",
  "in today's modern world",
  "in the modern world",
  "in this day and age",
  "in an ever-changing world",
  "in our fast-paced society",
  "in the ever-evolving",
  "welcome to",
  "hello everyone",
  "hi everyone",
  "hey guys",
  "hi guys",
  "today we will",
  "today we're going to",
  "in this article we will",
  "let's dive in",
];

// Textbook wrap-up phrases (matched at the start of the last paragraph).
const BANNED_CLOSERS = [
  "in conclusion",
  "to conclude",
  "to sum up",
  "to summarize",
  "in summary",
  "to wrap up",
  "in closing",
  "all in all",
  "at the end of the day",
  "ultimately", // "Ultimately, ..." as a summarizing tic
];

// Algorithm-penalized, saturated hooks and AI-tell vocabulary (matched anywhere).
const BANNED_HOOKS = [
  "did you know",
  "don't miss out",
  "let's explore",
  "let's find out",
  "you won't believe",
  "shocking truth",
  "everyone needs to know",
  "what they don't tell you",
  "this one weird trick",
  // AI-tell vocabulary: reads as machine prose wherever it appears.
  "delve",
  "delves",
  "delving",
  "delved",
  "rich tapestry",
  "embark on a journey",
  "unlock the power of",
  "in the realm of",
  "navigate the complexities",
  "it's important to note",
  "it's worth noting",
  "game changer",
  "buckle up",
];

// Morbid/fatal fear-metaphors used as clickbait doom-hooks (matched on the
// title). The house voice is warm and never needs these; the tone card forbids
// them and this is the mechanical backstop that forces a regenerate. Kept to
// high-signal compounds so it does not fire on benign copy.
const BANNED_TITLE_METAPHORS = [
  "slow suicide",     // "... is slow suicide"
  "killing you",      // "Your phone is killing you"
  "killing your",     // "X is killing your productivity"
  "kills your",
  "quietly killing",
  "silently killing",
  "killing yourself",
  "silent killer",
  "death sentence",   // "a death sentence for your focus"
  "digging your own grave",
];

// Redundant audience address the model tacks onto titles/prose ("... for our
// readers"): the whole site is for its readers, so the qualifier reads as
// machine-generated filler. Possessive/neutral uses ("for readers who commute")
// are deliberately NOT matched.
const REDUNDANT_AUDIENCE_RE =
  /\bfor\s+(?:our|the\s+modern)\s+readers?\b|\bfor\s+readers\s+like\s+you\b|\bdear\s+readers?\b/i;

const nfc = (s: string) => s.normalize("NFC");

// Template phrases a site wears out across articles. Warnings, not errors - each
// phrase can be legitimate in isolation; the house-voice prompt bans them and
// the critic penalizes them, this is the observability trail in the run logs.
const WORN_PHRASES = ["golden hour", "30-day challenge", "30 day challenge"];

// ── Matching ─────────────────────────────────────────────────────────────────
// A banned phrase can sit inside a longer, perfectly good one. Masked out before
// matching, same idea as safety.ts DEFAULT_ALLOW_PHRASES.
const RULE_ALLOW: string[] = [
  // "How did you know it was time to stop?" contains the saturated hook "did
  // you know" but is an ordinary question.
  "how did you know",
  "when did you know",
  "what did you know",
];

interface Rule {
  raw: string; // natural spelling, for the message/hint
  key: string; // folded, what we match on
}

const compile = (list: string[]): Rule[] =>
  list.map((raw) => ({ raw, key: foldAscii(raw) }));

const OPENERS = compile(BANNED_OPENERS);
const CLOSERS = compile(BANNED_CLOSERS);
const HOOKS = compile(BANNED_HOOKS);
const TITLE_METAPHORS = compile(BANNED_TITLE_METAPHORS);
const WORN = compile(WORN_PHRASES);

// Blank a phrase out, preserving length so startsWith offsets still hold.
const blank = (hay: string, needle: string) =>
  needle ? hay.split(needle).join(" ".repeat(needle.length)) : hay;

// Folded text with the benign supersets masked.
function keysFor(text: string): string {
  let folded = foldAscii(text);
  for (const a of RULE_ALLOW) folded = blank(folded, foldAscii(a));
  return folded;
}

// Word-boundary phrase tests on folded text.
const startsWithPhrase = (hay: string, key: string) =>
  hay.startsWith(key) && (hay.length === key.length || hay[key.length] === " ");
const hasPhrase = (hay: string, key: string) => ` ${hay} `.includes(` ${key} `);

// First matching rule, returned in its readable form so errors and the repair
// hint quote a phrase the model can parse.
function findRule(rules: Rule[], hay: string, mode: "starts" | "has"): string | undefined {
  for (const r of rules) {
    if (mode === "starts" ? startsWithPhrase(hay, r.key) : hasPhrase(hay, r.key)) return r.raw;
  }
  return undefined;
}

// Read-only accessors (admin surface + tests). Same contract as
// safety.ts builtinBlacklist: the rule lists are code, not config.
export function builtinRuleLists(): Record<string, string[]> {
  return {
    openers: [...BANNED_OPENERS],
    closers: [...BANNED_CLOSERS],
    hooks: [...BANNED_HOOKS],
    titleMetaphors: [...BANNED_TITLE_METAPHORS],
    worn: [...WORN_PHRASES],
  };
}

// Tags that must never appear in body HTML.
const FORBIDDEN_TAG_RE = /<\s*(script|style|iframe|object|embed|form|input)\b/i;
// "..., right?" / "..., isn't it?" as the very last words of the article.
const TAG_QUESTION_RE = /,\s*(?:right|isn't it|don't you think|doesn't it|aren't you|wouldn't you say)\s*\?+\s*$/i;
const ON_ATTR_RE = /\son\w+\s*=/i; // onerror=, onclick=, ...

// Keep the SEO / browser-tab title (metaTitle) free of the doom-clickbait and
// saturated hooks the tone card forbids. A metaTitle carrying one is dropped so
// <title>/og:title fall back to the (already title-gated) article title. A
// metaTitle that merely rewords the title for SEO is KEPT on purpose: keyword-
// forward SEO titles are desirable and legitimately differ from the on-page
// hook, so we do NOT measure word divergence (it flagged good SEO titles).
// `_title` is unused today but kept in the signature so the call sites stay
// stable and the metaTitle<->title pairing reads clearly. Returns the metaTitle
// to store ("" means "use the title").
export function reconcileMetaTitle(_title: string, metaTitle: string | undefined): string {
  const mt = (metaTitle ?? "").trim();
  if (!mt) return "";
  const km = keysFor(mt);
  if (findRule(TITLE_METAPHORS, km, "has")) return "";
  if (findRule(HOOKS, km, "has")) return "";
  if (REDUNDANT_AUDIENCE_RE.test(nfc(mt))) return "";
  return mt;
}

export function validateDraft(draft: Draft, opts: ValidateOptions): Verdict {
  const issues: Issue[] = [];
  const warnings: string[] = [];
  const fail = (code: IssueCode, message: string, fix: string) =>
    issues.push({ code, message, fix });

  const title = (draft.title ?? "").trim();
  const excerpt = (draft.excerpt ?? "").trim();
  const bodyHtml = draft.bodyHtml ?? "";

  // ── Title ──
  if (!title) fail("title.empty", "title: empty", "Give the article a title.");
  else {
    if (title.length < 10)
      fail(
        "title.short",
        `title: too short (${title.length} chars)`,
        "The title is too short. Rewrite it to be more specific (about 40-70 characters).",
      );
    if (title.length > 80) warnings.push(`title: long for SEO (${title.length} chars)`);
    const kt = keysFor(title);
    const hook = findRule(HOOKS, kt, "has");
    if (hook)
      fail(
        "title.hook",
        "title: uses a banned saturated hook",
        `The title uses the saturated hook "${hook}". Rewrite it around a benefit or a concrete detail and drop that phrase entirely.`,
      );
    const metaphor = findRule(TITLE_METAPHORS, kt, "has");
    if (metaphor)
      fail(
        "title.metaphor",
        "title: morbid fear-metaphor (doom clickbait)",
        `The title uses the morbid metaphor "${metaphor}" as clickbait. Rewrite it around the benefit or the fix: still compelling, but warm, and not scaring the reader.`,
      );
    const opener = findRule(OPENERS, kt, "starts");
    if (opener)
      fail(
        "title.opener",
        "title: greeting/essay opener",
        `The title opens with "${opener}", a greeting/essay opener. Get straight to the point.`,
      );
    if (REDUNDANT_AUDIENCE_RE.test(nfc(title)))
      fail(
        "title.localizer",
        'title: redundant audience tag ("for our readers") - the whole site is for its readers, rephrase without it',
        'The title carries a redundant audience tag ("for our readers"). Drop it; if you want to be specific, name a situation instead (office workers, new parents).',
      );
  }

  // ── Excerpt ──
  if (!excerpt) fail("excerpt.empty", "excerpt: empty", "Write a 1-2 sentence excerpt for the article (40-200 characters).");
  else {
    if (excerpt.length < 40) warnings.push(`excerpt: short (${excerpt.length} chars)`);
    if (excerpt.length > 320) warnings.push(`excerpt: long (${excerpt.length} chars)`);
  }

  // ── Body structure ──
  const h2 = (bodyHtml.match(/<h2\b/gi) || []).length;
  const paragraphs = (bodyHtml.match(/<p\b/gi) || []).length;
  const bodyText = stripHtml(bodyHtml);
  const words = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  if (!bodyHtml.trim()) {
    fail("body.empty", "body: empty", "The body is empty. Write the whole article.");
  } else {
    if (h2 < 2)
      fail(
        "body.h2",
        `body: needs >= 2 H2 sections (has ${h2})`,
        `The article has ${h2} <h2> sections and needs at least 2. Split the body into sections with specific subheadings.`,
      );
    if (paragraphs < 3)
      fail(
        "body.paragraphs",
        `body: needs >= 3 paragraphs (has ${paragraphs})`,
        `The article has ${paragraphs} paragraphs and needs at least 3 <p> paragraphs.`,
      );
    if (FORBIDDEN_TAG_RE.test(bodyHtml))
      fail(
        "body.forbidden_tag",
        "body: forbidden tag (script/iframe/...)",
        "The body contains forbidden tags (script/iframe/form...). Use only <p>, <h2>, <h3>, <ul>/<li>, <ol>/<li>, <strong>, <em>, <blockquote>.",
      );
    if (ON_ATTR_RE.test(bodyHtml))
      fail(
        "body.on_attr",
        "body: inline event handler attribute",
        "The body contains inline event-handler attributes (onclick=, onerror=...). Remove them all.",
      );
  }

  // ── Length ──
  // targetWords is aspirational; the gate is a flat "not thin" floor.
  // NOTE: a one-shot whole-article prompt struggles to reach a high floor when
  // the house voice caps a paragraph at ~3 short sentences. Length comes from
  // the section-by-section builder in generate.ts (more short paragraphs, not
  // longer ones), so this floor is reachable by construction rather than by
  // asking harder. Short English articles default to a 250-word floor;
  // override per call with opts.minWords.
  const minWords = opts.minWords ?? 250;
  const maxWords = opts.maxWords ?? Math.round(opts.targetWords * 1.9);
  if (words < minWords)
    fail(
      "body.too_short",
      `body: too short (${words} words, need >= ${minWords})`,
      `The article is ${words} words and needs at least ${minWords} (about ${minWords - words} words short). Do not pad: add NEW paragraphs with real substance - a concrete scenario, a number, a common mistake, or an exception.`,
    );
  if (words > maxWords) warnings.push(`body: long (${words} words, target ${opts.targetWords})`);

  // ── Opener / closer / hooks (on folded paragraph text) ──
  const paras = extractParagraphs(bodyHtml);
  if (paras.length) {
    const opener = findRule(OPENERS, keysFor(paras[0]), "starts");
    if (opener)
      fail(
        "body.opener",
        "body: banned essay/greeting opener",
        `The opening starts with "${opener}", a greeting/essay opener that reads as machine-written. Reopen with a concrete detail, a surprising number, or an everyday moment.`,
      );
    const closer = findRule(CLOSERS, keysFor(paras[paras.length - 1]), "starts");
    if (closer)
      fail(
        "body.closer",
        "body: textbook wrap-up closer (In conclusion/To sum up/...)",
        `The ending opens with "${closer}", a textbook wrap-up. End with ONE of these instead: a small action to take today, a line of dialogue, a return to the opening image, a memorable number, or a genuinely open question.`,
      );
  }
  const kb = keysFor(bodyText);
  const bodyHook = findRule(HOOKS, kb, "has");
  if (bodyHook)
    fail(
      "body.hook",
      `body: banned saturated hook ("${bodyHook}")`,
      `The body uses the saturated hook or AI-tell phrase "${bodyHook}". Remove it and state the point directly.`,
    );
  if (REDUNDANT_AUDIENCE_RE.test(nfc(`${excerpt}\n${bodyText}`)))
    fail(
      "body.localizer",
      'body: redundant audience tag ("for our readers" / "dear readers") - drop the phrase',
      'The article carries a redundant audience tag ("for our readers" / "dear readers"). The site is already for its readers - drop the phrase.',
    );

  // ── Worn template phrases + tag-question sign-off (warnings) ──
  const kTitle = keysFor(title);
  for (const w of WORN) {
    if (hasPhrase(kb, w.key) || hasPhrase(kTitle, w.key))
      warnings.push(`worn template phrase ("${w.raw}")`);
  }
  if (paras.length && TAG_QUESTION_RE.test(paras[paras.length - 1].replace(/[\u2018\u2019]/g, "'")))
    warnings.push("closer: tag-question sign-off (..., right?)");

  // ── Duplicate paragraph (LLM repetition) ──
  const seen = new Set<string>();
  for (const p of paras) {
    const key = foldAscii(p);
    if (key.length > 40) {
      if (seen.has(key)) {
        fail(
          "body.dup_para",
          "body: a paragraph is repeated verbatim",
          "A paragraph is repeated verbatim in the article. Remove the repeat or replace it with new content.",
        );
        break;
      }
      seen.add(key);
    }
  }

  // ── AI-tell glyphs: sanitize fixes these at publish, so only warn ──
  const glyphs = findAiTell(`${title}\n${excerpt}\n${bodyHtml}`);
  if (glyphs.length)
    warnings.push(`ai-tell glyphs present (auto-cleaned): ${glyphs.slice(0, 6).join(" ")}`);

  return {
    ok: issues.length === 0,
    issues,
    errors: issues.map((i) => i.message),
    warnings,
    stats: { words, h2, paragraphs },
  };
}

// Which issues a targeted repair can fix vs which need a fresh draft. Anything
// NOT listed here (an empty/unparseable body, a missing title) means the draft
// has no salvageable substance, so the loop re-rolls instead of patching.
const REPAIRABLE: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "title.short",
  "title.hook",
  "title.metaphor",
  "title.opener",
  "title.localizer",
  "body.h2",
  "body.paragraphs",
  "body.forbidden_tag",
  "body.on_attr",
  "body.too_short",
  "body.opener",
  "body.closer",
  "body.hook",
  "body.localizer",
  "body.dup_para",
]);

export function isRepairable(issues: Issue[]): boolean {
  return issues.length > 0 && issues.every((i) => REPAIRABLE.has(i.code));
}

// Pull the text of each <p>...</p> in order.
function extractParagraphs(html: string): string[] {
  const out: string[] = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = stripHtml(m[1]);
    if (text) out.push(text);
  }
  return out;
}
