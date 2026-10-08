import { describe, expect, test } from "vitest";
import { builtinAllowPhrases, builtinBlacklist, checkSafety, hasHardHit } from "../src/pipeline/safety";
import { foldAscii } from "../src/lib/slug";
import { EXPECTED_GROUPS } from "./fixtures/blacklist-groups";

describe("checkSafety - HARD block", () => {
  test("a sexual term hard-fails", () => {
    const r = checkSafety("An article about pornography and adult video sites");
    expect(r.ok).toBe(false);
    expect(r.hardHits.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.startsWith("hard:"))).toBe(true);
  });

  test("sensitive politics hard-fails", () => {
    const r = checkSafety("A call to overthrow the government by force");
    expect(r.ok).toBe(false);
    expect(r.hardHits.some((h) => h.group === "politics")).toBe(true);
  });

  test("sovereignty terms hard-fail", () => {
    expect(checkSafety("Sovereignty over the Spratly Islands and the Paracel Islands").ok).toBe(false);
  });

  test("illegal drug term hard-fails", () => {
    const r = checkSafety("How to run drug trafficking routes online");
    expect(r.ok).toBe(false);
    expect(r.hardHits.some((h) => h.group === "illegal")).toBe(true);
  });

  test("self-harm method phrase hard-fails", () => {
    expect(checkSafety("A guide on how to commit suicide without pain").ok).toBe(false);
  });

  test("unproven cure claim hard-fails", () => {
    const r = checkSafety("This leaf cures cancer completely");
    expect(r.ok).toBe(false);
    expect(r.hardHits.some((h) => h.group === "medical_claim")).toBe(true);
  });

  test("guarantee and financial return claims hard-fail", () => {
    expect(checkSafety("This supplement is guaranteed to cure arthritis").hardHits[0]?.group).toBe(
      "guarantee_claim",
    );
    expect(checkSafety("Invest today for guaranteed high returns").hardHits[0]?.group).toBe(
      "financial_claim",
    );
  });
});

describe("checkSafety - case and diacritic folding", () => {
  test("case, punctuation and diacritics do not hide a term", () => {
    expect(checkSafety("Loud calls for COCAINE!").ok).toBe(false);
    expect(checkSafety("Buying cocaïne online").ok).toBe(false);
  });
});

describe("checkSafety - SOFT threshold", () => {
  test("under threshold passes", () => {
    // one distinct SOFT hit ("gory"), default threshold 2
    const r = checkSafety("The scene was a little gory for my taste");
    expect(r.softHits.length).toBe(1);
    expect(r.ok).toBe(true);
  });

  test("over threshold fails with a soft reason", () => {
    const r = checkSafety("A gory, gruesome, grisly and horrifying scene");
    expect(r.softHits.length).toBeGreaterThan(2);
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("soft>"))).toBe(true);
  });

  test("softThreshold is configurable", () => {
    const text = "A gory scene that was also grisly";
    expect(checkSafety(text, { softThreshold: 2 }).ok).toBe(true);
    expect(checkSafety(text, { softThreshold: 1 }).ok).toBe(false);
  });
});

describe("checkSafety - idiom whitelist (no false positives)", () => {
  test('"kill time" is not a violence hit', () => {
    const r = checkSafety("Stop trying to kill time on social media");
    expect(r.softHits.length).toBe(0);
    expect(r.ok).toBe(true);
  });

  test('real "kill" is still caught alongside the idiom', () => {
    const r = checkSafety("He wanted to kill someone just to kill time");
    expect(r.softHits.some((h) => h.term === "kill")).toBe(true);
  });

  test("extra allowPhrases from config mask a soft term", () => {
    // "gory" as an idiom is contrived, but proves config-driven masking works
    expect(checkSafety("So gory", { softThreshold: 0 }).ok).toBe(false);
    expect(checkSafety("So gory", { softThreshold: 0, allowPhrases: ["so gory"] }).ok).toBe(true);
  });
});

describe("checkSafety - ambiguous words are NOT flagged", () => {
  test('"grape" does not trip "rape" (word boundaries)', () => {
    expect(checkSafety("Grape juice and rapeseed oil are pantry staples").ok).toBe(true);
  });

  test('"suicide prevention" (mental health) is safe', () => {
    expect(checkSafety("Suicide prevention hotlines are open all night").ok).toBe(true);
  });

  test('"cut-throat competition" (idiom) is safe', () => {
    expect(checkSafety("Cut-throat competition at work raises stress").ok).toBe(true);
  });

  test('"get-rich-quick schemes" (a warning) is safe', () => {
    expect(checkSafety("Beware of get-rich-quick schemes online").ok).toBe(true);
  });

  test('"no miracle cure" (debunking) is safe', () => {
    expect(checkSafety("There is no miracle cure for poor sleep").ok).toBe(true);
  });

  test('"don\'t torture yourself" (self-compassion) passes under threshold', () => {
    const r = checkSafety("Don't torture yourself over one small mistake");
    expect(r.hardHits.length).toBe(0);
    expect(r.softHits.length).toBe(0);
    expect(r.ok).toBe(true);
  });
});

describe("checkSafety - config", () => {
  test("disabled short-circuits to ok even with a hard term", () => {
    const r = checkSafety("pornography and genocide", { enabled: false });
    expect(r.ok).toBe(true);
    expect(r.hardHits.length).toBe(0);
  });

  test("extraHardTerms adds a custom hard term", () => {
    const r = checkSafety("A topic about casino bonuses", { extraHardTerms: ["casino"] });
    expect(r.ok).toBe(false);
    expect(r.hardHits.some((h) => h.term === "casino")).toBe(true);
  });
});

describe("hasHardHit", () => {
  test("true on a HARD topic, false on a benign one", () => {
    expect(hasHardHit("Calls to overthrow the government")).toBe(true);
    expect(hasHardHit("How to plan your morning routine")).toBe(false);
  });

  test("SOFT-only text is not a hard hit", () => {
    expect(hasHardHit("A gory, gruesome, horrifying scene")).toBe(false);
  });
});

// ── List integrity ──────────────────────────────────────────────────────────
// Structural checks that keep the term lists maintainable.

describe("safety lists: structural integrity", () => {
  test("the taxonomy groups and their severities match the fixture", () => {
    const actual = Object.fromEntries(builtinBlacklist().map((g) => [g.name, g.severity]));
    expect(actual).toEqual(EXPECTED_GROUPS);
  });

  test("every term is non-empty after folding and unique within its group", () => {
    for (const g of builtinBlacklist()) {
      const folded = g.terms.map((t) => foldAscii(t));
      expect({ [g.name]: folded.filter((f) => !f) }).toEqual({ [g.name]: [] });
      expect({ [g.name]: folded.length }).toEqual({ [g.name]: new Set(folded).size });
    }
  });

  test("every whitelist idiom masks a SOFT term (no dead entries)", () => {
    const soft = builtinBlacklist()
      .filter((g) => g.severity === "soft")
      .flatMap((g) => g.terms.map((t) => foldAscii(t)));
    for (const phrase of builtinAllowPhrases()) {
      const words = ` ${foldAscii(phrase)} `;
      const covered = soft.some((t) => words.includes(` ${t} `));
      expect({ phrase, covered }).toEqual({ phrase, covered: true });
    }
  });
});

describe("safety hits report the readable term", () => {
  test("a hit surfaces the term as authored, not the folded form", () => {
    // This string reaches content_queue.last_error AND the regenerate hint in
    // the prompt, so it must be the readable phrase.
    const r = checkSafety("This tea is a miracle cure for burnout");
    expect(r.hardHits.some((h) => h.term === "is a miracle cure")).toBe(true);
  });
});
