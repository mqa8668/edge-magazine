import { describe, expect, test } from "vitest";
import {
  DEFAULT_HOUSE_VOICE,
  DEFAULT_PERSONA_SEEDS,
  DEFAULT_TONE_CARD,
  endingPrompt,
  expandSectionPrompt,
  ideationPrompt,
  leadPrompt,
  outlinePrompt,
  patchPartPrompt,
  planArticle,
  sectionPrompt,
  type Outline,
} from "../src/pipeline/prompts";
import type { StyleAssignment } from "../src/pipeline/rotation";

const style: StyleAssignment = {
  categorySlug: "systems",
  personaSlug: "desk-focus",
  formula: "pas",
  articleType: "how-to",
  targetWords: 1300,
  lengthBucket: "medium",
};

const outline = (): Outline => ({
  title: "Why you wake up at three in the morning",
  coreMessage: "Waking in the night is usually a body-clock issue, not insomnia.",
  excerpt: "A short look at sleep and what to do when you wake in the middle of the night.",
  metaTitle: "Waking at 3 a.m.: causes and fixes",
  metaDescription: "Why you wake at 3 a.m. and what to do to fall back asleep.",
  tags: ["sleep", "habits"],
  imageQuery: "bedroom night clock",
  sections: [
    { h2: "The mechanism behind the wake-up", job: "Explain the body clock", must: "a figure from a study" },
    { h2: "Three things to avoid", job: "Name common mistakes", must: "a mistake people often make" },
  ],
  faq: [],
});

describe("prompt language: English, no house brand", () => {
  test("the house voice and tone card are English and carry the core bans", () => {
    expect(DEFAULT_HOUSE_VOICE).toContain("In conclusion");
    expect(DEFAULT_HOUSE_VOICE).toContain("Did you know");
    expect(DEFAULT_TONE_CARD).toContain("the habit that is killing you");
    for (const block of [DEFAULT_HOUSE_VOICE, DEFAULT_TONE_CARD, ...Object.values(DEFAULT_PERSONA_SEEDS)]) {
      expect(block).toMatch(/^[\x00-\x7F]*$/); // plain ASCII English
    }
  });

  test("every persona is labelled as an AI persona", () => {
    expect(Object.keys(DEFAULT_PERSONA_SEEDS).length).toBeGreaterThanOrEqual(3);
    for (const [slug, seed] of Object.entries(DEFAULT_PERSONA_SEEDS)) {
      expect({ [slug]: /AI writing persona/.test(seed) }).toEqual({ [slug]: true });
    }
  });

  test("no prompt layer leaks AI-tell punctuation into the model's context", () => {
    const { system } = outlinePrompt(style, { topic: "Sleeping enough but tired", categoryName: "Wellbeing" });
    for (const glyph of ["\u2014", "\u2013", "\u2026", "\u201c", "\u201d", "\u2018", "\u2019"]) {
      expect({ glyph, present: system.includes(glyph) }).toEqual({ glyph, present: false });
    }
  });
});

describe("planArticle: length by construction", () => {
  // The old one-shot prompt asked for 1300 words while the house rhythm rules
  // (<= 3 short sentences per paragraph, 3-6 sections of 2-4 paragraphs)
  // ceilinged the body near 720. Length now comes from paragraph COUNT.
  test("the plan can actually reach the target", () => {
    const plan = planArticle(1300);
    const reachable =
      plan.leadWords + plan.endingWords + plan.sectionCount * plan.wordsPerSection;
    expect(reachable).toBeGreaterThanOrEqual(1300 * 0.95);
  });

  test("sections are asked for many short paragraphs, not few long ones", () => {
    expect(planArticle(1300).paragraphsPerSection).toBeGreaterThanOrEqual(5);
  });

  test("section count stays inside the house 4-6 range across every length bucket", () => {
    for (const target of [1050, 1250, 1300, 1500]) {
      const { sectionCount } = planArticle(target);
      expect({ target, ok: sectionCount >= 4 && sectionCount <= 6 }).toEqual({ target, ok: true });
    }
  });
});

describe("outlinePrompt", () => {
  test("carries the tone + safety card and the anti-template rules", () => {
    const { system } = outlinePrompt(style, { topic: "Time management", categoryName: "Systems" });
    expect(system).toContain("CONTENT SAFETY");
    expect(system).toContain("kill time"); // the gentle-synonym example
    expect(system).toContain("NEVER include sensitive content");
    expect(system).toContain("VARIETY");
    expect(system).toContain("golden hour"); // worn-phrase ban
    expect(system).toContain("Desk: Focus"); // persona card
  });

  test("plans exactly the number of sections the length plan asks for", () => {
    const { system } = outlinePrompt(style, { topic: "A", categoryName: "B" });
    expect(system).toContain(`EXACTLY ${planArticle(style.targetWords).sectionCount} elements`);
  });

  test("demands a different concrete element per section (substance, not padding)", () => {
    const { system } = outlinePrompt(style, { topic: "A", categoryName: "B" });
    expect(system).toContain("DIFFERENT CONCRETE ELEMENT");
    expect(system).toContain("Do NOT give two sections the same kind of element");
  });

  test("faq hint demands additive answers and carries the avoid-list", () => {
    const { user } = outlinePrompt(style, {
      topic: "Sleeping enough but tired",
      categoryName: "Wellbeing",
      faqAvoid: ["How long should a nap be?", "Is coffee bad for sleep?"],
    });
    expect(user).toContain("ADD information not already in the body");
    expect(user).toContain("AVOID re-asking questions");
    expect(user).toContain("How long should a nap be?");
  });

  test("faq hint omits the avoid block when there is nothing to avoid", () => {
    const { user } = outlinePrompt(style, { topic: "A", categoryName: "B" });
    expect(user).not.toContain("AVOID re-asking questions");
  });
});

describe("sectionPrompt", () => {
  test("scopes the writer to one section and names the others as off-limits", () => {
    const { system, user } = sectionPrompt(style, outline(), 0);
    expect(system).toContain("EXACTLY ONE SECTION");
    expect(user).toContain("The mechanism behind the wake-up");
    expect(user).toContain("a figure from a study"); // the assigned must
    expect(user).toContain("Three things to avoid"); // the neighbour, as do-not-touch
    expect(user).toContain("do NOT drift into their content");
  });

  test("asks for the planned paragraph count, and bans per-section wrap-ups", () => {
    const { system } = sectionPrompt(style, outline(), 0);
    expect(system).toContain(`${planArticle(style.targetWords).paragraphsPerSection} short paragraphs`);
    expect(system).toContain("concluding the section yourself");
  });

  test("the section writer never sees the formula card (it would re-run the whole arc)", () => {
    const { system } = sectionPrompt(style, outline(), 0);
    expect(system).not.toContain("Formula PAS");
    // ...while the arc-shaping calls do.
    expect(leadPrompt(style, outline()).system).toContain("Formula PAS");
  });

  test("sections must not emit their own h2 (the assembler owns headings)", () => {
    const { system, user } = sectionPrompt(style, outline(), 0);
    expect(system).toContain("Do NOT use <h2>");
    expect(user).toContain("Do NOT include an <h2> tag");
  });
});

describe("endingPrompt", () => {
  test("gets the real lead so it can close the loop, and bans textbook closers", () => {
    const { system, user } = endingPrompt(style, outline(), "<p>The clock said 3:07.</p>");
    expect(user).toContain("The clock said 3:07.");
    expect(system).toContain('NEVER open the ending with "In conclusion"');
  });
});

describe("repair prompts", () => {
  test("expansion asks for new substance and explicitly forbids padding", () => {
    const { system, user } = expandSectionPrompt(style, outline(), 0, "<p>Short.</p>", 180);
    expect(system).toContain("The WRONG way");
    expect(system).toContain("restating existing ideas at length");
    expect(system).toContain("better to stay short");
    expect(user).toContain("<p>Short.</p>"); // the model SEES its own text
    expect(user).toContain("180 more words");
  });

  test("a patch hands back the draft with one instruction and keeps the rest", () => {
    const { system, user } = patchPartPrompt(
      style,
      { label: "ending", html: "<p>In conclusion, be patient.</p>" },
      "The ending opens with \"In conclusion\".",
    );
    expect(system).toContain("Fix only the problem named");
    expect(system).toContain("not a rewrite");
    expect(user).toContain("<p>In conclusion, be patient.</p>");
    expect(user).toContain("PROBLEM TO FIX:");
  });
});

describe("ideationPrompt", () => {
  test("forbids sensitive topics up front", () => {
    const { system } = ideationPrompt({ categoryName: "Systems", count: 5, coveredTopics: [] });
    expect(system).toContain("NEVER propose topics");
  });

  test("anchors topics to real demand queries when a pool is supplied", () => {
    const { user } = ideationPrompt({
      categoryName: "Wellbeing",
      count: 3,
      coveredTopics: [],
      demandKeywords: ["cant sleep what to do", "how long to nap"],
    });
    expect(user).toContain("REAL DEMAND DATA");
    expect(user).toContain("cant sleep what to do");
    expect(user).toContain("copied VERBATIM");
  });
});

describe("cross-section evidence ownership", () => {
  // Sections are written in parallel and cannot see each other's text. On the
  // first real run two sections both cited the same "23 minutes to refocus"
  // study, so each section is now told which evidence belongs to whom.
  test("a section sees the other sections' assigned concrete element", () => {
    const { user } = sectionPrompt(style, outline(), 0);
    expect(user).toContain("this section covers: a mistake people often make");
    expect(user).toContain("must NOT reuse another section's evidence");
  });
});
