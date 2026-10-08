// Content safety gate for the autonomous pipeline. A severity-tiered blacklist
// that runs over generated titles/excerpts/bodies (and ideation topics) so the
// site never publishes sensitive, unsafe or legally risky material. This is a
// brand AND legal guardrail: medical-cure, financial-return and guarantee claims
// are the classic ways an automated publisher gets a site into trouble, and
// politically sensitive content is a risk for most publishers.
//
// Three tiers:
//   HARD  - never publish. A hit makes the draft fail; the generate loop
//           regenerates and, if it persists, the item is markFailed (never
//           published). Ideation topics with a HARD hit are dropped before they
//           are ever enqueued.
//   SOFT  - gruesome/vulgar vocabulary that is tolerated in small doses but
//           discouraged. More than `softThreshold` distinct SOFT hits fails the
//           draft (regenerate with a "write more gently" hint).
//   (idiom whitelist) - benign phrases that contain a SOFT word ("kill time")
//           are masked out before matching so they never count as a hit.
//
// Matching runs on diacritic-folded, lowercased text with punctuation collapsed
// to single spaces (foldAscii), and terms match on WORD boundaries. So "Cocaine",
// "COCAINE!" and "cocaine" all match, "Cocaine" with a diaeresis matches too, and
// "grape" never trips "rape".
//
// CURATION RULE (be careful): keep terms SPECIFIC. A false positive blocks
// legitimate prose, so ambiguous bare words are deliberately excluded and the
// exclusion is noted inline. Equally important: a word that is used to DENY a
// claim ("there is no miracle cure for insomnia", "beware of get-rich-quick
// schemes") cannot be a blocklist entry - only the claim SHAPE can ("this tea is
// a miracle cure"). Every sentence that once tripped a term belongs in
// test/safety-false-positives.test.ts. Prevention lives in the prompt tone card;
// this list is the backstop, not the first line.

import { foldAscii } from "../lib/slug";

export type Severity = "hard" | "soft";

export interface SafetyGroup {
  name: string; // taxonomy group id, surfaced in reasons
  severity: Severity;
  terms: string[]; // terms/phrases; folded for matching
}

// A term kept in both forms: `key` is what we match on (folded), `raw` is what
// we report (admin panel, last_error, and the LLM regenerate hint).
interface CompiledTerm {
  raw: string;
  key: string;
}

interface CompiledGroup {
  name: string;
  severity: Severity;
  terms: CompiledTerm[];
}

function compileTerms(terms: string[]): CompiledTerm[] {
  return terms
    .map((t) => {
      const raw = t.trim();
      return { raw, key: foldAscii(raw) };
    })
    .filter((t) => t.key);
}

// Structurally compatible with RuntimeConfig["safety"] (runtime-config.ts) so
// the caller can pass cfg.safety directly. Kept as its own interface here to
// avoid a circular import; safety.ts stays dependency-light (only foldAscii).
export interface SafetyConfig {
  enabled?: boolean;
  softThreshold?: number; // max distinct SOFT hits before it fails
  extraHardTerms?: string[]; // admin additions (no redeploy)
  extraSoftTerms?: string[];
  allowPhrases?: string[]; // extra benign idioms to whitelist
}

export interface SafetyHit {
  term: string;
  group: string;
  severity: Severity;
}

export interface SafetyResult {
  ok: boolean;
  hardHits: SafetyHit[];
  softHits: SafetyHit[]; // distinct SOFT hits (deduped by group+term)
  reasons: string[]; // short human-readable summary for last_error / logs
}

export const DEFAULT_SOFT_THRESHOLD = 2;

// ── The blacklist ────────────────────────────────────────────────────────────
// Grouped by taxonomy. Comments call out why obvious-looking words are absent.
// This is a starter list for a general-interest magazine; operators extend it at
// runtime through config.safety.extraHardTerms / extraSoftTerms.

const RAW_BLACKLIST: SafetyGroup[] = [
  // 1. Sexual / adult (HARD). Explicit only. EXCLUDED: bare "sex" (sex
  //    differences in sleep, "sex education"), "nude" (art history), "adult"
  //    (adult learners). We key on explicit compounds.
  {
    name: "sexual",
    severity: "hard",
    terms: [
      "pornography", "porn", "xxx", "sex tape", "sex video", "adult film",
      "adult video", "masturbation", "sexual intercourse", "prostitution",
      "escort service", "child porn", "pedophilia", "incest", "rape",
      "sexual assault", "explicit video", "leaked nudes", "nude photos",
    ],
  },

  // 2. Sensitive politics + sovereignty (HARD). Kept to conflict-specific
  //    compounds. EXCLUDED: bare "protest", "election", "government", "regime"
  //    (ordinary civic vocabulary), "separatist" alone (history pieces).
  {
    name: "politics",
    severity: "hard",
    terms: [
      "overthrow the government", "overthrow the regime", "overthrow the state",
      "topple the government", "incite insurrection", "armed insurrection",
      "incite a riot", "incite riots", "color revolution", "hostile forces",
      "treason", "sedition", "separatist movement",
      // sovereignty / territorial disputes
      "Paracel Islands", "Spratly Islands", "nine-dash line",
    ],
  },

  // 3. Religion (HARD) - only incitement/defamation compounds. Mindfulness,
  //    meditation and spirituality are IN scope, so NO bare religion words.
  {
    name: "religion",
    severity: "hard",
    terms: [
      "religious extremism", "religious fanaticism", "incite religious hatred",
      "religious hatred", "religious conflict", "religious war",
      "defame religion", "heretic cult",
    ],
  },

  // 4. Illegal activity (HARD). EXCLUDED: bare "weapon" (metaphor "secret
  //    weapon"), "addictive" ("addictive games"), "gamble"/"gambling" (a
  //    gambling-addiction article is in scope), "scam" (scam-awareness is in
  //    scope), "drug" (drug interactions, pharmacy advice), "ecstasy" (joy).
  {
    name: "illegal",
    severity: "hard",
    terms: [
      "heroin", "cocaine", "methamphetamine", "crystal meth", "opium",
      "buy illegal drugs", "drug trafficking", "drug dealing", "drug smuggling",
      "manufacture drugs", "online gambling", "betting tips", "sports betting",
      "illegal gambling", "underground lottery", "money laundering",
      "launder money", "build a bomb", "make explosives", "homemade gun",
      "ghost gun",
    ],
  },

  // 5. Hate / discrimination (HARD) - incitement compounds only. EXCLUDED bare
  //    "racism"/"discrimination": an anti-discrimination piece uses them
  //    legitimately.
  {
    name: "hate",
    severity: "hard",
    terms: [
      "incite hatred", "ethnic hatred", "racial hatred", "ethnic cleansing",
      "genocide", "white supremacist", "white supremacy",
    ],
  },

  // 6. Self-harm / suicide (HARD) - METHOD & PROMOTION phrases ONLY. Mental
  //    health, depression, "thoughts of suicide", "suicide prevention" must NOT
  //    be blocked, so there is deliberately NO bare "suicide". We block only
  //    how-to / encouragement phrasing.
  {
    name: "self_harm",
    severity: "hard",
    terms: [
      "how to commit suicide", "suicide methods", "painless suicide",
      "suicide pact", "how to kill yourself", "ways to kill yourself",
      "kill myself", "end your own life", "end my own life",
      "how to take your own life", "slit your wrists", "hang yourself",
      "overdose on purpose",
    ],
  },

  // 7. Extreme / graphic violence (HARD) - atrocity vocabulary a general
  //    magazine never needs. EXCLUDED: "torture" (moved to SOFT: "don't torture
  //    yourself over it" is a common supportive phrase), "cut throat"
  //    ("cut-throat competition"), "terrorism" (news analysis), "shooting".
  {
    name: "violence_extreme",
    severity: "hard",
    terms: [
      "beheading", "decapitate", "decapitation", "dismember", "dismemberment",
      "disembowel", "public execution", "massacre", "mass murder", "snuff film",
    ],
  },

  // 8. Unproven medical cure claims (HARD). Complements the on-page health
  //    disclaimer. Cure-all quackery only - the term has to BE a claim.
  //    EXCLUDED bare "miracle cure", "cures cancer", "cure-all": honest
  //    debunking ("there is no miracle cure for insomnia", "no herb cures
  //    cancer") is exactly the writing we want, and a word used to DENY quackery
  //    cannot be a blocklist entry. Only the claim shape can.
  {
    name: "medical_claim",
    severity: "hard",
    terms: [
      "cured my cancer", "cured her cancer", "cured his cancer",
      "cure your cancer", "cure your diabetes", "cures cancer completely",
      "cures diabetes completely", "cures cancer in", "cures all diseases",
      "cures any disease", "cure all diseases", "heals all diseases",
      "is a miracle cure", "reverse diabetes in",
    ],
  },

  // 9. Guarantee claims (HARD). Absolute promises about health or results that
  //    no honest publisher can make. EXCLUDED bare "guaranteed results" and
  //    "guarantee": "nobody can offer guaranteed results" is a fair sentence.
  {
    name: "guarantee_claim",
    severity: "hard",
    terms: [
      "guaranteed to cure", "guaranteed cure", "guaranteed weight loss",
      "guaranteed to work for everyone", "works for everyone guaranteed",
      "100 percent guaranteed cure",
    ],
  },

  // 10. Financial return claims (HARD). Same rule as medical: the CLAIM shape,
  //     not the debunking vocabulary. EXCLUDED bare "guaranteed returns" and
  //     "get rich quick": "beware of get-rich-quick schemes" is a legitimate
  //     warning.
  {
    name: "financial_claim",
    severity: "hard",
    terms: [
      "guaranteed high returns", "guaranteed monthly income",
      "guaranteed profits every", "risk free returns", "double your money in",
      "how to get rich quick", "guaranteed passive income",
    ],
  },

  // 11. Gruesome / morbid vocabulary (SOFT). Tolerated in small doses, softened
  //     by the tone card. EXCLUDED: bare "dead"/"death"/"die" (idioms like "dead
  //     tired", "to die for"), "blood" (blood pressure, blood sugar), "abuse"
  //     and "assault" (legit awareness pieces). "kill" is kept but the "kill
  //     time" idiom family is whitelisted below.
  {
    name: "violence",
    severity: "soft",
    terms: [
      "kill", "killing", "stabbing", "stabbed", "murder", "bloodbath",
      "bloodshed", "bloody", "gory", "gruesome", "grisly", "corpse",
      "dead body", "horrifying", "horror", "savage", "brutality", "torture",
    ],
  },

  // 12. Profanity / insults (SOFT) - unambiguous vulgar words and internet
  //     abbreviations only. EXCLUDED "damn", "hell", "crap", "ass" (donkey),
  //     "hoe" (garden tool), "dick" (a name) and any insult that is also an
  //     ordinary word.
  {
    name: "profanity",
    severity: "soft",
    terms: [
      "fuck", "fucking", "fucked", "motherfucker", "shit", "shitty",
      "bullshit", "asshole", "bastard", "bitch", "dickhead", "douchebag",
      "wtf", "stfu",
    ],
  },
];

// Benign idioms containing a SOFT word - masked out before matching so they are
// never a hit. The critical entries protect "kill" and "torture".
const DEFAULT_ALLOW_PHRASES: string[] = [
  "kill time", "killing time", "kill the time", "killing the time",
  "kill two birds", "killing two birds", "kill the lights", "kill switch",
  "kill it", "killing it",
  // "don't torture yourself over a missed workout" is a phrase the house voice
  // actively wants; the violence group's own comment says so, but nothing was
  // masking it.
  "torture yourself", "torture myself",
  "horror movie night",
];

// Compile every list once: matching uses `key`, reporting uses `raw`.
const BLACKLIST: CompiledGroup[] = RAW_BLACKLIST.map((g) => ({
  name: g.name,
  severity: g.severity,
  terms: compileTerms(g.terms),
}));

const ALLOW_PHRASES: CompiledTerm[] = compileTerms(DEFAULT_ALLOW_PHRASES);

// ── Built-in list accessors (admin read-only surface) ───────────────────────
// The blacklist is code, not config: the admin panel shows it read-only so an
// operator can see exactly what is already blocked (and only ADDS via
// config.safety.extra*Terms). Returns the human-authored RAW form grouped by
// taxonomy.

export function builtinBlacklist(): SafetyGroup[] {
  return RAW_BLACKLIST.map((g) => ({ ...g, terms: [...g.terms] }));
}

export function builtinAllowPhrases(): string[] {
  return [...DEFAULT_ALLOW_PHRASES];
}

// ── Matching ─────────────────────────────────────────────────────────────────

// Blank out each whitelisted phrase (preserving the boundary spaces on either
// side) so a SOFT word inside a benign idiom is not seen by term matching.
function maskIn(padded: string, needles: string[]): string {
  let out = padded;
  for (const n of needles) {
    if (!n) continue;
    const needle = ` ${n} `;
    let idx = out.indexOf(needle);
    while (idx !== -1) {
      // keep the leading space (idx..idx+1) and the trailing space; blank the term
      out = out.slice(0, idx + 1) + " ".repeat(n.length) + out.slice(idx + 1 + n.length);
      idx = out.indexOf(needle, idx + 1);
    }
  }
  return out;
}

// The text to match against: folded, space-padded, benign idioms blanked out.
function buildHaystack(text: string, allow: CompiledTerm[]): string {
  return maskIn(` ${foldAscii(text)} `, allow.map((a) => a.key));
}

// Match on the folded key, report the raw term - the hit string travels to
// last_error, the admin panel, and the LLM regenerate hint.
function findHits(hay: string, groups: CompiledGroup[]): SafetyHit[] {
  const hits: SafetyHit[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const term of g.terms) {
      if (hay.includes(` ${term.key} `)) {
        const key = `${g.severity}:${g.name}:${term.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ term: term.raw, group: g.name, severity: g.severity });
      }
    }
  }
  return hits;
}

// Admin-added terms may be typed in any case or with diacritics; compileTerms
// folds them for matching and keeps whatever the admin typed for reporting.
function effectiveGroups(cfg: SafetyConfig): CompiledGroup[] {
  const groups = [...BLACKLIST];
  const extraHard = compileTerms(cfg.extraHardTerms ?? []);
  const extraSoft = compileTerms(cfg.extraSoftTerms ?? []);
  if (extraHard.length) groups.push({ name: "custom", severity: "hard", terms: extraHard });
  if (extraSoft.length) groups.push({ name: "custom", severity: "soft", terms: extraSoft });
  return groups;
}

function summarize(hits: SafetyHit[]): string {
  const byGroup = new Map<string, string[]>();
  for (const h of hits) {
    const list = byGroup.get(h.group) ?? [];
    if (!list.includes(h.term)) list.push(h.term);
    byGroup.set(h.group, list);
  }
  return [...byGroup.entries()]
    .map(([g, terms]) => `${g} (${terms.slice(0, 4).join(", ")})`)
    .join("; ");
}

// Scan text for blacklist hits. `cfg.enabled === false` short-circuits to ok.
export function checkSafety(text: string, cfg: SafetyConfig = {}): SafetyResult {
  if (cfg.enabled === false) {
    return { ok: true, hardHits: [], softHits: [], reasons: [] };
  }

  const allow = [...ALLOW_PHRASES, ...compileTerms(cfg.allowPhrases ?? [])];
  const all = findHits(buildHaystack(text, allow), effectiveGroups(cfg));
  const hardHits = all.filter((h) => h.severity === "hard");
  const softHits = all.filter((h) => h.severity === "soft");

  const softThreshold = cfg.softThreshold ?? DEFAULT_SOFT_THRESHOLD;
  const softOver = softHits.length > softThreshold;
  const ok = hardHits.length === 0 && !softOver;

  const reasons: string[] = [];
  if (hardHits.length) reasons.push(`hard: ${summarize(hardHits)}`);
  if (softOver) reasons.push(`soft>${softThreshold}: ${summarize(softHits)}`);

  return { ok, hardHits, softHits, reasons };
}

// Convenience for the ideation topic filter: does this text hit a HARD term?
// (SOFT topics are fine to ideate - the draft-level gate handles density.)
export function hasHardHit(text: string, cfg: SafetyConfig = {}): boolean {
  if (cfg.enabled === false) return false;
  const allow = [...ALLOW_PHRASES, ...compileTerms(cfg.allowPhrases ?? [])];
  const hay = buildHaystack(text, allow);
  return effectiveGroups(cfg).some(
    (g) =>
      g.severity === "hard" &&
      g.terms.some((t) => hay.includes(` ${t.key} `)),
  );
}
