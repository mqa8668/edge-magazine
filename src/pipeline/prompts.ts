// Prompt library. Composes: house voice (always) + persona seed + formula card +
// article type + JSON contract. The voice, personas, formulas and article types
// come from the active niche pack (src/pipeline/niche.ts), so a site changes
// its editorial identity by swapping that pack rather than editing this file.
//
// ARTICLE STRUCTURE: an article is NOT generated in one call. See generate.ts -
// we build an outline, then write the lead, each section, and the ending
// separately. That makes length a property of STRUCTURE instead of a number we
// beg for. The house rhythm rules (short sentences, paragraphs of <= 3
// sentences) mathematically ceiling a one-shot article well below the target
// length, so the fix is more short paragraphs, each with its own job.
//
// The prompts forbid AI-tell punctuation, so this file uses straight quotes and
// "-" like the content it produces.

import type { StyleAssignment } from "./rotation";
import { niche } from "./niche";

// The persona- and formula-independent rules. Exported as the DEFAULT: the
// admin can override it via runtime config (config.prompts.houseVoice); each
// builder falls back to this whenever the override is blank.
export const DEFAULT_HOUSE_VOICE = niche.houseVoice;

// Tone + content-safety card. Applied to EVERY call, before the persona seed, so
// the voice stays warm and the draft never drifts into sensitive territory. This
// is the prevention half of the safety system; src/pipeline/safety.ts is the
// detection backstop. Admin-overridable via config.prompts.toneCard.
export const DEFAULT_TONE_CARD = niche.toneCard;

// Author voices. Slug -> a short seed appended to the system prompt.
// Admin-overridable per slug via config.prompts.personas[slug]; a blank override
// falls back to the default seed here.
export const DEFAULT_PERSONA_SEEDS: Record<string, string> = Object.fromEntries(
  niche.personas.map((p) => [p.slug, p.voice]),
);

// Formula skeletons. Concise so they steer structure, not length. Exported
// (read-only reference in the admin config panel).
export const FORMULA_CARDS: Record<string, string> = { ...niche.formulas };

export const ARTICLE_TYPE_HINTS: Record<string, string> = { ...niche.articleTypes };

// Admin-editable overrides for the three prompt layers the article system is
// built from. Blank/absent fields fall back to the DEFAULT_* constants above,
// so a misconfigured (empty) prompt can never ship an empty system message.
export interface PromptOverrides {
  houseVoice?: string;
  toneCard?: string;
  personas?: Record<string, string>;
}

// ── Article plan (length by construction) ───────────────────────────────────

// How an article of `targetWords` is cut into parts. The lead and the ending are
// deliberately small; the body sections carry the volume, and they carry it via
// MORE short paragraphs rather than longer ones (the house voice caps a paragraph
// at ~3 short sentences, so paragraph COUNT is the only honest length lever).
export interface ArticlePlan {
  sectionCount: number;
  wordsPerSection: number;
  paragraphsPerSection: number;
  leadWords: number;
  endingWords: number;
}

const LEAD_SHARE = 0.12;
const ENDING_SHARE = 0.08;
// A house paragraph is ~3 sentences of 10-14 words, so about this many
// whitespace-separated words - the unit validate.ts measures. Deriving the
// paragraph count from it keeps the ask arithmetically honest.
const WORDS_PER_PARAGRAPH = 36;

export function planArticle(targetWords: number): ArticlePlan {
  const leadWords = Math.round(targetWords * LEAD_SHARE);
  const endingWords = Math.round(targetWords * ENDING_SHARE);
  const bodyWords = targetWords - leadWords - endingWords;
  const sectionCount = Math.min(6, Math.max(4, Math.round(targetWords / 260)));
  const wordsPerSection = Math.round(bodyWords / sectionCount);
  const paragraphsPerSection = Math.min(
    8,
    Math.max(4, Math.round(wordsPerSection / WORDS_PER_PARAGRAPH)),
  );
  return { sectionCount, wordsPerSection, paragraphsPerSection, leadWords, endingWords };
}

// One planned section from the outline call.
export interface OutlineSection {
  h2: string;
  job: string; // what this section does in the arc (1 sentence)
  must: string; // the concrete element it has to carry
}

export interface Outline {
  title: string;
  coreMessage: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  tags: string[];
  imageQuery: string;
  sections: OutlineSection[];
  faq: { q: string; a: string }[];
}

// The layered system prompt every article call shares. `formula` is only handed
// to the calls that shape the arc (outline, lead, ending) - a section writer that
// sees the full formula tends to re-run the whole arc inside its own section.
function baseSystem(
  style: StyleAssignment,
  overrides: PromptOverrides,
  opts: { withFormula?: boolean } = {},
): string[] {
  const houseVoice = (overrides.houseVoice ?? "").trim() || DEFAULT_HOUSE_VOICE;
  const toneCard = (overrides.toneCard ?? "").trim() || DEFAULT_TONE_CARD;
  const persona =
    (overrides.personas?.[style.personaSlug] ?? "").trim() ||
    DEFAULT_PERSONA_SEEDS[style.personaSlug] ||
    "";
  const out = [houseVoice, toneCard, persona];
  if (opts.withFormula) out.push(FORMULA_CARDS[style.formula] ?? "");
  return out.filter(Boolean);
}

// ── 1. Outline ───────────────────────────────────────────────────────────────
// Cheap call (~700 output tokens) that decides the arc. Everything structural is
// gated here, BEFORE any prose is paid for: section count, anti-template heading
// rules, the title tone rules, and each section's assigned job + concrete element.

export function outlinePrompt(
  style: StyleAssignment,
  input: {
    topic: string;
    categoryName: string;
    keyword?: string;
    tagVocab?: string[];
    faqAvoid?: string[];
  },
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const plan = planArticle(style.targetWords);
  const typeHint = ARTICLE_TYPE_HINTS[style.articleType] ?? "";

  const system = [
    ...baseSystem(style, overrides, { withFormula: true }),
    `Article type: ${typeHint}`,
    `YOUR TASK RIGHT NOW: you are NOT writing the article yet. You are only drafting its OUTLINE - the title, the core message, and ${plan.sectionCount} <h2> sections. A writer will use this outline to write each section separately, so every section needs a CLEAR job and must NOT overlap another section.`,
    `IMPORTANT - each section must carry a DIFFERENT CONCRETE ELEMENT (the "must" field), rotating between: a number or study, an everyday scene with sensory detail, a mistake people commonly make, an exception ("when this does not work"), a comparison or contrast. Do NOT give two sections the same kind of element. This is what gives the article real substance instead of generalities.`,
    OUTLINE_CONTRACT(plan.sectionCount),
  ].join("\n\n");

  const user = [
    `Draft an outline for an article in the "${input.categoryName}" category about this topic:`,
    `"${input.topic}"`,
    input.keyword ? `Main SEO keyword, to appear naturally: ${input.keyword}.` : "",
    faqHint(input.faqAvoid),
    tagVocabHint(input.tagVocab),
    `Return ONLY one JSON object matching the schema described above, with no explanation.`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

// The house voice tells the model to use straight double quotes in prose - and it
// obeys, INSIDE JSON string values, which produces `"must": "the "deadline" scene
// at 2 a.m."` and an unparseable object. Every JSON contract therefore pins inner
// quoting to single quotes.
const JSON_QUOTE_RULE = `QUOTE RULE (required; if broken the JSON is invalid and the whole article is discarded): INSIDE a JSON value, when you need to quote or emphasise something, use ONLY single quotes '...'. NEVER use a double quote " inside a value, because it breaks the JSON.`;

const OUTLINE_CONTRACT = (sectionCount: number) => `Return ONLY one valid JSON object with these keys:
{
  "title": "an engaging title, no greeting, at most 70 characters. VARY the opening style (question, number, contrarian claim, concrete benefit) - do NOT overuse a fixed template such as 'Seven ...'",
  "coreMessage": "ONE sentence: the core message the whole article revolves around. Every section must serve this sentence",
  "excerpt": "1-2 lead-in sentences, 40-200 characters",
  "metaTitle": "SEO title for the article: keyword-forward, on the SAME topic and with the same warm voice as the article (no drift to another topic, no scare tactics or sensationalism), at most 60 characters",
  "metaDescription": "SEO description, at most 160 characters",
  "tags": ["3 to 5 short tags; PREFER copying verbatim from the EXISTING TAG LIST when one is provided, at most 1 new tag"],
  "sections": [
    {
      "h2": "section heading - a SPECIFIC phrase (at most ONE section in the whole article may be a question; the first section must NOT open with 'Why' out of habit; only number it 'Step 1/2/3' if the article is a step-by-step guide)",
      "job": "ONE sentence: what this section does in the arc, and what it does NOT do (so it does not overlap other sections)",
      "must": "the concrete element this section is required to carry - say exactly what it is, for example 'a figure from a study on short naps' or 'a 3 p.m. office scene with sensory detail'"
    }
  ],
  "faq": [{"q": "a question a READER would really type into Google about this topic (short, natural)", "a": "a brief 1-3 sentence answer, useful, direct, no rambling"}],
  "imageQuery": "a short English phrase for finding an illustrative stock photo (for example: 'morning routine coffee desk')"
}
The "sections" array must have EXACTLY ${sectionCount} elements.

${JSON_QUOTE_RULE}`;

// ── 2. Lead ──────────────────────────────────────────────────────────────────

export function leadPrompt(
  style: StyleAssignment,
  outline: Outline,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const plan = planArticle(style.targetWords);
  const system = [
    ...baseSystem(style, overrides, { withFormula: true }),
    `YOUR TASK RIGHT NOW: write only the OPENING (the part before the first subheading). No title, no sections, no ending.`,
    `The opening must stop a skimming reader with one CONCRETE detail (a scene, a figure, a line of dialogue, a contrarian claim), then lead to the core message. Follow the opening beat of the formula above.`,
    `Length: ${plan.leadWords} words, split into 2-3 short paragraphs.`,
    HTML_FRAGMENT_CONTRACT,
  ].join("\n\n");

  const user = [
    `Article title: ${outline.title}`,
    `Core message: ${outline.coreMessage}`,
    `The sections that will follow (you do NOT write them; they are only so you know where the opening has to lead and avoid stealing their material):`,
    outline.sections.map((s, i) => `${i + 1}. ${s.h2} - ${s.job}`).join("\n"),
    `Write the opening. Return ONLY JSON: {"html": "..."}`,
  ].join("\n");

  return { system, user };
}

// ── 3. Section ───────────────────────────────────────────────────────────────
// The volume-carrying call. One section per call so the model can spend its whole
// attention (and its whole output budget) on one job instead of compressing a
// full article into a single JSON blob.

export function sectionPrompt(
  style: StyleAssignment,
  outline: Outline,
  index: number,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const plan = planArticle(style.targetWords);
  const section = outline.sections[index];
  // Each section also sees the OTHER sections' assigned concrete element, not
  // just their heading. Sections are written in parallel and cannot see each
  // other's text, so without this two of them reach for the same famous
  // statistic. Naming who owns what keeps the evidence distinct.
  const others = outline.sections
    .map((s, i) => (i === index ? null : `${i + 1}. ${s.h2} - ${s.job} (this section covers: ${s.must})`))
    .filter(Boolean)
    .join("\n");

  const system = [
    ...baseSystem(style, overrides),
    `YOUR TASK RIGHT NOW: write EXACTLY ONE SECTION of a longer article, not the whole article.`,
    `Length of this section: about ${plan.wordsPerSection} words, split into ${plan.paragraphsPerSection} short paragraphs (each at most 3 sentences, in the house rhythm). Many SHORT paragraphs, not a few long ones.`,
    `Each paragraph must do its own job: set up a situation, give evidence or a number, argue against itself, name a common mistake, give a concrete method, state an exception. If a paragraph adds no new information, DELETE it - fewer paragraphs beat padding.`,
    `FORBIDDEN in a section: repeating another section's content; opening with "In this section..."; concluding the section yourself ("In short, ..."); re-introducing the topic as if the reader just arrived. This section sits in the MIDDLE of the article and the reader has already read what came before.`,
    HTML_FRAGMENT_CONTRACT,
  ].join("\n\n");

  const user = [
    `Article title: ${outline.title}`,
    `Core message of the whole article: ${outline.coreMessage}`,
    ``,
    `THE SECTION YOU MUST WRITE (section ${index + 1}/${outline.sections.length}):`,
    `Section heading: ${section.h2}`,
    `Job of this section: ${section.job}`,
    `CONCRETE element this section MUST contain: ${section.must}`,
    ``,
    `The other sections in the article (do NOT write them, do NOT drift into their content). Evidence or figures assigned to another section belong to that section - you must NOT reuse another section's evidence; find your own:`,
    others,
    ``,
    `Write the body of this section. Do NOT include an <h2> tag (the system adds it). Return ONLY JSON: {"html": "..."}`,
  ].join("\n");

  return { system, user };
}

// ── 4. Ending ────────────────────────────────────────────────────────────────

export function endingPrompt(
  style: StyleAssignment,
  outline: Outline,
  leadHtml: string,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const plan = planArticle(style.targetWords);
  const system = [
    ...baseSystem(style, overrides, { withFormula: true }),
    `YOUR TASK RIGHT NOW: write only the ENDING (1-2 final paragraphs, about ${plan.endingWords} words). No subheading, no recap of the sections.`,
    `Choose ONE ending style that suits the piece: one small action to take today / a line of dialogue / a return to the image from the opening / a number worth remembering / a genuinely open question.`,
    `NEVER open the ending with "In conclusion", "To sum up", "Overall", "In summary", or "Finally,". No empty maxims, no well-wishes.`,
    HTML_FRAGMENT_CONTRACT,
  ].join("\n\n");

  const user = [
    `Article title: ${outline.title}`,
    `Core message: ${outline.coreMessage}`,
    `The opening already written (so you can close the loop or return to its image if that fits):`,
    leadHtml,
    `Sections already in the article: ${outline.sections.map((s) => s.h2).join(" | ")}`,
    `Write the ending. Return ONLY JSON: {"html": "..."}`,
  ].join("\n");

  return { system, user };
}

const HTML_FRAGMENT_CONTRACT = `Return ONLY one valid JSON object: {"html": "..."}
"html" is an HTML fragment using only these tags: <p>, <h3>, <ul>/<li>, <ol>/<li>, <strong>, <em>, <blockquote>. Do NOT use <h2>. Do NOT wrap in <html>/<body>. Do NOT insert images. Do NOT add any explanation outside the JSON.

${JSON_QUOTE_RULE} Dialogue in the text also uses single quotes: <p>He said: 'let's figure it out tomorrow'.</p>`;

// ── 5. Repair ────────────────────────────────────────────────────────────────
// A failed gate used to throw the whole article away and re-roll the same prompt
// - which does essentially nothing because the model never saw its own previous
// text. These two prompts hand the draft BACK with one surgical instruction.

// Expand one section that came out thin. Deliberately framed as "add new
// substance", never "write longer" - padding is what a quality rater punishes.
export function expandSectionPrompt(
  style: StyleAssignment,
  outline: Outline,
  index: number,
  currentHtml: string,
  addWords: number,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const section = outline.sections[index];
  const system = [
    ...baseSystem(style, overrides),
    `YOUR TASK RIGHT NOW: EXPAND one already-written section of the article, keeping its voice and the ideas already there.`,
    `The RIGHT way to expand: add NEW paragraphs with real information - a concrete situation with detail, a figure or study, a common mistake and how to avoid it, an exception, an objection followed by an answer.`,
    `The WRONG way (never do this): restating existing ideas at length, adding filler words, adding empty transition sentences, repeating the conclusion. If you cannot think of valuable new information, it is better to stay short.`,
    `Keep the existing paragraphs (light polishing is fine) and insert the new paragraphs where they fit. Paragraphs stay at most 3 sentences.`,
    HTML_FRAGMENT_CONTRACT,
  ].join("\n\n");

  const user = [
    `Article title: ${outline.title}`,
    `Core message: ${outline.coreMessage}`,
    `Section: ${section.h2} - ${section.job}`,
    ``,
    `Current section content:`,
    currentHtml,
    ``,
    `Add about ${addWords} more words to this section with NEW content (about ${Math.max(1, Math.round(addWords / WORDS_PER_PARAGRAPH))} more paragraphs). Return the WHOLE section after expansion. Return ONLY JSON: {"html": "..."}`,
  ].join("\n");

  return { system, user };
}

// Fix one specific gate failure in one part of the article (lead / a section /
// ending). `instruction` is the `fix` string from validate.ts.
export function patchPartPrompt(
  style: StyleAssignment,
  part: { label: string; html: string },
  instruction: string,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const system = [
    ...baseSystem(style, overrides),
    `YOUR TASK RIGHT NOW: FIX one specific problem in one already-written part of the article. Fix only the problem named, and keep everything else (ideas, voice, length, unrelated paragraphs). This is an edit, not a rewrite.`,
    HTML_FRAGMENT_CONTRACT,
  ].join("\n\n");

  const user = [
    `Part to fix: ${part.label}`,
    ``,
    `Current content:`,
    part.html,
    ``,
    `PROBLEM TO FIX: ${instruction}`,
    ``,
    `Return the WHOLE part after the fix. Return ONLY JSON: {"html": "..."}`,
  ].join("\n");

  return { system, user };
}

// Rewrite just the title/metaTitle when a title gate fails - no need to touch a
// body that already passed.
export function patchTitlePrompt(
  style: StyleAssignment,
  outline: Outline,
  instruction: string,
  overrides: PromptOverrides = {},
): { system: string; user: string } {
  const system = [
    ...baseSystem(style, overrides),
    `YOUR TASK RIGHT NOW: write a new TITLE for an article that is already written. Keep the body as is; change only the title.`,
    `Return ONLY JSON: {"title": "...", "metaTitle": "..."} - title at most 70 characters, metaTitle keyword-forward at most 60 characters, on the same topic and with the same warm voice as the article.`,
  ].join("\n\n");

  const user = [
    `Current title: ${outline.title}`,
    `Core message of the article: ${outline.coreMessage}`,
    `Sections in the article: ${outline.sections.map((s) => s.h2).join(" | ")}`,
    ``,
    `PROBLEM TO FIX: ${instruction}`,
    ``,
    `Write a new title. Return ONLY JSON: {"title": "...", "metaTitle": "..."}`,
  ].join("\n");

  return { system, user };
}

// ── Shared hints ─────────────────────────────────────────────────────────────

// Controlled tag vocabulary, appended to the outline user message. Free-form tag
// generation fragments the taxonomy into one-post tags; this pins the model to
// the existing vocabulary and allows at most ONE genuinely new tag.
export function tagVocabHint(vocab?: string[]): string {
  if (!vocab?.length) return "";
  return [
    `EXISTING TAG LIST (for the "tags" field): ${vocab.join(", ")}.`,
    `Choose the 2-4 tags CLOSEST in meaning to the article from the list above, copied EXACTLY character for character.`,
    `Only if the article truly needs a concept that NONE of the tags above can express, add AT MOST 1 new tag: short (1-4 words), lowercase, not overlapping in meaning with an existing tag.`,
  ].join(" ");
}

// Guidance for the faq field. The FAQ must ADD information, not restate the body
// (a rater reads restated FAQ as padding), and must not recycle questions other
// articles already answered.
export function faqHint(avoidQuestions?: string[]): string {
  const avoid = avoidQuestions?.length
    ? ` AVOID re-asking questions that other articles on the site already used (even if reworded): ${avoidQuestions.slice(0, 30).join(" | ")}.`
    : "";
  return (
    'Add 2-3 "faq" entries: each is a practical question readers often type into Google about the topic (not an academic question), and it must NOT repeat the idea of a subheading already in the outline. ' +
    'Each answer is 1-3 sentences and must ADD information not already in the body (a figure, an exception, a common mistake, or "when this does not work") - do NOT copy ideas already written above. ' +
    "If the topic does not suit an FAQ, return an empty array." +
    avoid
  );
}

// ── Ideation ─────────────────────────────────────────────────────────────────

// Prompt to propose fresh topics for a category, avoiding what is already covered.
export function ideationPrompt(input: {
  categoryName: string;
  categoryDescription?: string;
  count: number;
  coveredTopics: string[];
  demandKeywords?: string[];
  seedTopics?: string[];
}): { system: string; user: string } {
  const system = `You are a content editor for ${niche.siteName}, an English-language website about ${niche.subject}. You propose SPECIFIC, useful article topics with their own angle - never generic, never duplicates. Every topic must differ clearly in perspective from the others.

SAFETY: NEVER propose topics about politics or sovereignty, sex, violence or gore, drugs, gambling, weapons or illegal activity, divisive religion, hate or discrimination, self-harm, or promises to cure illness. Propose only positive, safe, useful topics inside the site's subject.`;

  const avoid = input.coveredTopics.length
    ? `ALREADY COVERED. NEVER propose anything that duplicates the MEANING of any item in this list, even if worded differently, and avoid motifs that have been overused (for example the mid-afternoon energy crash, phone-scrolling addiction, interval repetition) unless you have a genuinely new angle:\n- ${input.coveredTopics.slice(0, 80).join("\n- ")}`
    : "";

  const scope = input.categoryDescription
    ? `Category scope (topics MUST stay inside this scope and not drift elsewhere): ${input.categoryDescription}`
    : "";

  const seeds = input.seedTopics?.length
    ? `Style reference only (topics that show the level of specificity wanted; do not copy them):\n- ${input.seedTopics.join("\n- ")}`
    : "";

  // Real search demand (Google Search Console), ranked most-searched first.
  // When present, topics MUST anchor to a real query and "keyword" MUST be that
  // query verbatim - this is what turns blind ideation into demand-driven ideation.
  const demand = input.demandKeywords?.length
    ? `REAL DEMAND DATA (very important): below are queries PEOPLE ACTUALLY TYPE into search boxes (from search suggestions, ranked by popularity, most popular first).
- Every topic you propose MUST target ONE real query from this list (or a very close variant with the same search intent).
- The "keyword" field MUST be that query, copied VERBATIM.
- Prefer queries near the top (higher demand).
- WARNING: this list comes from automatic suggestions, so it CONTAINS many OFF-TOPIC queries - physics/chemistry/biology terms, economics or politics, translation questions ("... in Spanish"), homework ("... essay", "... grade 10"). NEVER use those. Pick only queries that truly belong to the site's subject and fit the category scope.
Query list:
- ${input.demandKeywords.slice(0, 60).join("\n- ")}`
    : "";

  const user = [
    `Propose ${input.count} article topics for the "${input.categoryName}" category.`,
    scope,
    seeds,
    demand,
    `Each topic needs a specific angle (not a generic "How to sleep well" but "Why you wake at 3 a.m. and how to handle it"). Aim at real problems in the reader's daily life and stay on the category's core. Make topics specific through circumstance (office workers, new parents, night owls), not through nationality.`,
    avoid,
    input.demandKeywords?.length
      ? `Return ONLY one JSON object: {"topics": [{"topic": "...", "keyword": "the real query you target (copied verbatim from the list above)", "imageQuery": "a short English phrase for finding a photo"}]}`
      : `Return ONLY one JSON object: {"topics": [{"topic": "...", "keyword": "SEO keyword", "imageQuery": "a short English phrase for finding a photo"}]}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

// ── Critic ───────────────────────────────────────────────────────────────────

// Critic pass (optional): a second model judges the draft against the house
// rubric. It scores; the mechanical validator has already run, so this catches
// what regexes cannot - flat hooks, tell-dont-show, listicle monotony, robotic
// cadence. Score < quality.criticMinScore triggers a repair (still inside
// maxGenAttempts).
export function criticPrompt(draft: {
  title: string;
  excerpt: string;
  bodyHtml: string;
}): { system: string; user: string } {
  const system = `You are a demanding editor at a magazine about ${niche.subject}. You score drafts on how NATURAL and how USEFUL they are, and you spot mechanical-sounding prose. You grade strictly but fairly.`;

  const user = [
    `Score the article below from 1 to 10 (10 = reads like a real person wrote it, gripping hook, advice that can be used right away; 5 = acceptable but bland; below 4 = machine-like, cliche, formulaic).`,
    `Criteria (each weak one lowers the score):
- Opening hook: does it pull the reader in, or is it a cliche opener?
- Show-don't-tell: are there concrete examples and situations, or just exhortation?
- Machine voice: evenly repeating structure, lifeless lists, a "to sum up" ending?
- Advice: usable right away, or generic ("be patient", "keep trying")?
- Ending: does it land naturally, or lecture?
- Template feel: subheadings that are all "Why..." questions, every section numbered "Step 1/2/3" though it is not a how-to, a closing platitude, worn phrases ("golden hour", "30-day challenge")?
- Padding: does any paragraph only restate what was said without adding information? (A long but empty article must score low.)`,
    `TITLE: ${draft.title}`,
    `OPENING: ${draft.excerpt}`,
    `BODY (HTML): ${draft.bodyHtml.slice(0, 6000)}`,
    `Return ONLY one JSON object: {"score": <integer 1-10>, "reasons": ["short reason, at most 3"]}`,
  ].join("\n\n");

  return { system, user };
}
