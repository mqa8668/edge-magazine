import { describe, expect, test } from "vitest";
import {
  builtinRuleLists,
  isRepairable,
  reconcileMetaTitle,
  validateDraft,
  type Draft,
} from "../src/pipeline/validate";
import { foldAscii } from "../src/lib/slug";

// Body with n words spread across 3 paragraphs and 2 H2 sections.
function bodyWith(words: number): string {
  const filler = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
  const third = Math.ceil(words / 3);
  const parts = [
    filler.split(" ").slice(0, third).join(" "),
    filler.split(" ").slice(third, 2 * third).join(" "),
    filler.split(" ").slice(2 * third).join(" "),
  ];
  return `<p>${parts[0]}</p><h2>Part one</h2><p>${parts[1]}</p><h2>Part two</h2><p>${parts[2]}</p>`;
}

const goodDraft = (): Draft => ({
  title: "Why you wake up at three in the morning",
  excerpt: "A short look at sleep and what to do when you wake in the dead of night.",
  bodyHtml: bodyWith(330),
  tags: ["sleep", "habits"],
});

// A first paragraph of ~620 filler words that starts with `p`, plus the minimum
// structure so only the opener rule can fail.
const withOpener = (p: string): Draft => ({
  ...goodDraft(),
  bodyHtml: `<p>${p} ${Array.from({ length: 620 }, (_, i) => `w${i}`).join(" ")}</p><h2>A</h2><p>x y z</p><h2>B</h2><p>x y z</p>`,
});

describe("validateDraft", () => {
  test("a well-formed draft passes", () => {
    const v = validateDraft(goodDraft(), { targetWords: 600 });
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
    expect(v.stats.h2).toBe(2);
  });

  test("too few H2 sections fails", () => {
    const d = { ...goodDraft(), bodyHtml: `<p>a</p><p>b</p><p>c</p>${"<p>x y z</p>".repeat(200)}` };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("H2"))).toBe(true);
  });

  test("a thin body (below minWords) fails", () => {
    const v = validateDraft({ ...goodDraft(), bodyHtml: bodyWith(120) }, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  test("minWords defaults to 250 and is configurable", () => {
    const d = { ...goodDraft(), bodyHtml: bodyWith(300) };
    expect(validateDraft(d, { targetWords: 600 }).ok).toBe(true); // default floor 250
    expect(validateDraft(d, { targetWords: 600, minWords: 400 }).ok).toBe(false);
    expect(validateDraft(d, { targetWords: 600, minWords: 250 }).ok).toBe(true);
  });

  test("a banned essay opener fails", () => {
    const v = validateDraft(withOpener("In today's fast-paced world,"), { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("opener"))).toBe(true);
  });

  test("a forbidden tag fails", () => {
    const d = { ...goodDraft(), bodyHtml: goodDraft().bodyHtml + "<script>alert(1)</script>" };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("forbidden tag"))).toBe(true);
  });

  test("an empty title fails", () => {
    const v = validateDraft({ ...goodDraft(), title: "" }, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("title"))).toBe(true);
  });

  test("a too-short title fails", () => {
    const v = validateDraft({ ...goodDraft(), title: "Sleep" }, { targetWords: 600 });
    expect(v.issues.some((i) => i.code === "title.short")).toBe(true);
  });

  test("a morbid fear-metaphor title fails", () => {
    const d = { ...goodDraft(), title: "Sitting for eight hours a day is slow suicide" };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("fear-metaphor"))).toBe(true);
  });

  test('the redundant "for our readers" audience tag fails in the title', () => {
    const d = { ...goodDraft(), title: "An anti-aging diet for our readers" };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("audience tag"))).toBe(true);
  });

  test('the redundant audience tag fails in the body', () => {
    const d = goodDraft();
    d.bodyHtml += "<p>This is a meal plan written for our readers with busy weeks.</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("audience tag"))).toBe(true);
  });

  test('"dear readers" fails in the excerpt', () => {
    const d = { ...goodDraft(), excerpt: "Dear readers, here is how to fix the breakfast habit that keeps tripping you up." };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
  });

  test('"for readers who commute" (neutral use) does NOT trip the audience gate', () => {
    const d = { ...goodDraft(), title: "Five ways to beat writer's block for readers who commute" };
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(true);
  });

  test("AI-tell vocabulary such as delve fails", () => {
    const d = goodDraft();
    d.bodyHtml += "<p>Let us delve into the habits that shape your evenings.</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === "body.hook")).toBe(true);
  });

  test('a longer word containing a banned one ("delved" aside, "develop") is allowed', () => {
    const d = goodDraft();
    d.bodyHtml += "<p>Develop a habit of laying out clothes the night before.</p>";
    expect(validateDraft(d, { targetWords: 600 }).ok).toBe(true);
  });

  test("a repeated paragraph fails with body.dup_para", () => {
    const d = goodDraft();
    const p = "<p>This paragraph is long enough to be fingerprinted as a repeat of itself.</p>";
    d.bodyHtml += p + p;
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.issues.some((i) => i.code === "body.dup_para")).toBe(true);
  });

  test("a textbook closer fails", () => {
    const d = goodDraft();
    d.bodyHtml += "<p>In conclusion, sleep matters and routines help.</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.issues.some((i) => i.code === "body.closer")).toBe(true);
  });
});

describe("reconcileMetaTitle", () => {
  const title = "Sitting all day is stressful: I tried 4-7-8 breathing and cortisol dropped 73%";

  test("keeps a keyword-forward SEO reword of the same topic", () => {
    // Legit SEO titles differ in wording from the on-page hook - never drop them.
    expect(
      reconcileMetaTitle(title, "4-7-8 breathing exercise to lower cortisol at your desk"),
    ).not.toBe("");
  });

  test("drops a doom-metaphor metaTitle (falls back to the title)", () => {
    // The SEO headline must not carry doom clickbait either.
    expect(
      reconcileMetaTitle(title, "The virtual keyboard effect is killing your productivity and how to fix it"),
    ).toBe("");
    expect(reconcileMetaTitle(title, "Your phone is killing you every single day")).toBe("");
  });

  test("drops a saturated-hook metaTitle", () => {
    expect(reconcileMetaTitle(title, "Did you know breathing lowers stress")).toBe("");
  });

  test("blank/undefined metaTitle stays empty (falls back to the title)", () => {
    expect(reconcileMetaTitle(title, "")).toBe("");
    expect(reconcileMetaTitle(title, undefined)).toBe("");
  });

  test("drops a metaTitle with the redundant audience tag", () => {
    expect(reconcileMetaTitle(title, "A breathing routine to cut stress for our readers")).toBe("");
  });
});

describe("worn template phrases + tag-question closer (warnings)", () => {
  test("a worn phrase in the body warns but does not fail", () => {
    const d = goodDraft();
    d.bodyHtml = d.bodyHtml.replace("Part one", "The golden hour of the brain");
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("golden hour"))).toBe(true);
  });

  test("the 30-day-challenge motif warns", () => {
    const d = goodDraft();
    d.bodyHtml += "<p>Start your own 30-day challenge today to build the habit.</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("30-day challenge"))).toBe(true);
  });

  test("a tag-question sign-off warns", () => {
    const d = goodDraft();
    d.bodyHtml += "<p>Sounds familiar, right?</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes("tag-question"))).toBe(true);
  });

  test("a clean draft raises none of these warnings", () => {
    const v = validateDraft(goodDraft(), { targetWords: 600 });
    expect(v.warnings.filter((w) => w.includes("worn") || w.includes("tag-question"))).toHaveLength(0);
  });
});

// ── Normalization behavior ──────────────────────────────────────────────────

describe("rule matching is case, punctuation and diacritic insensitive", () => {
  test("variants of the same opener trip the same rule", () => {
    for (const opener of ["In today's fast-paced world", "IN TODAY\u2019S FAST PACED WORLD,", "in today's FAST-PACED world..."]) {
      const v = validateDraft(withOpener(opener), { targetWords: 600 });
      expect({ opener, hit: v.issues.some((i) => i.code === "body.opener") }).toEqual({ opener, hit: true });
    }
  });

  test("every rule list entry is plain lowercase-foldable English", () => {
    const lists = builtinRuleLists();
    for (const [name, entries] of Object.entries(lists)) {
      const empty = entries.filter((e) => !foldAscii(e));
      expect({ [name]: empty }).toEqual({ [name]: [] });
      expect(entries.length).toBeGreaterThan(0);
    }
  });
});

describe("issue codes + repairability", () => {
  test("a too-short body is repairable and carries an English fix hint", () => {
    const v = validateDraft({ ...goodDraft(), bodyHtml: bodyWith(150) }, { targetWords: 600 });
    const issue = v.issues.find((i) => i.code === "body.too_short");
    expect(issue).toBeDefined();
    // The hint is what reaches the repair prompt: quantified + actionable.
    expect(issue?.fix).toContain(`about ${250 - v.stats.words} words short`);
    expect(issue?.fix).toContain("add NEW paragraphs");
    expect(isRepairable(v.issues)).toBe(true);
  });

  test("an empty body is NOT repairable (nothing to patch - re-roll instead)", () => {
    const v = validateDraft({ ...goodDraft(), bodyHtml: "" }, { targetWords: 600 });
    expect(v.issues.some((i) => i.code === "body.empty")).toBe(true);
    expect(isRepairable(v.issues)).toBe(false);
  });

  test("a clean draft has no issues and is not 'repairable'", () => {
    const v = validateDraft(goodDraft(), { targetWords: 600 });
    expect(v.issues).toHaveLength(0);
    expect(isRepairable(v.issues)).toBe(false);
  });

  test("errors stays in sync with issues (last_error/logs contract)", () => {
    const v = validateDraft({ ...goodDraft(), bodyHtml: bodyWith(150) }, { targetWords: 600 });
    expect(v.errors).toEqual(v.issues.map((i) => i.message));
  });
});

// ── False positives on good prose ───────────────────────────────────────────
// A banned phrase can sit inside a longer good one. Same class of bug as the
// safety blacklist - see test/safety-false-positives.test.ts.
describe("rule lists do not fire on good prose", () => {
  test('"How did you know ..." is not the "did you know" hook', () => {
    const d = goodDraft();
    d.bodyHtml += "<p>How did you know it was time to stop? Write down the first sign.</p>";
    const v = validateDraft(d, { targetWords: 600 });
    expect(v.issues.map((i) => i.code)).toEqual([]);
  });

  test('a concrete opener such as "This time last year" is fine', () => {
    const v = validateDraft(withOpener("This time last year you said the same thing."), {
      targetWords: 600,
    });
    expect(v.issues.map((i) => i.code)).toEqual([]);
  });

  test('"Overall, ..." is not a banned closer', () => {
    const d = goodDraft();
    d.bodyHtml += "<p>Overall, pick one small change and do it tomorrow.</p>";
    expect(validateDraft(d, { targetWords: 600 }).issues.map((i) => i.code)).toEqual([]);
  });

  // ...and the real rules still fire.
  test("the real openers/hooks are still caught", () => {
    expect(
      validateDraft(withOpener("Welcome to my blog, everyone."), { targetWords: 600 }).issues.some(
        (i) => i.code === "body.opener",
      ),
    ).toBe(true);
    const d = goodDraft();
    d.bodyHtml += "<p>Did you know that five minutes is enough?</p>";
    expect(validateDraft(d, { targetWords: 600 }).issues.some((i) => i.code === "body.hook")).toBe(true);
  });
});
