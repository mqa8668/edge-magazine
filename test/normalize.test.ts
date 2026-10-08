import { describe, expect, test } from "vitest";
import { containment, normalizeTopic, jaccard, isDuplicate } from "../src/pipeline/normalize";

describe("normalizeTopic", () => {
  test("folds diacritics and is word-order independent", () => {
    const a = normalizeTopic("Morning habits that stick");
    const b = normalizeTopic("stick habits morning that");
    expect(a.key).toBe(b.key); // sorted-token key
    expect(a.key).not.toContain(" ");
  });

  test("diacritic and no-diacritic forms normalize alike", () => {
    const withDia = normalizeTopic("Crème brûlée habits");
    const noDia = normalizeTopic("creme brulee habits");
    expect(withDia.key).toBe(noDia.key);
  });

  test("empty-ish input yields an empty key", () => {
    expect(normalizeTopic("").key).toBe("");
    expect(normalizeTopic(null).key).toBe("");
  });
});

describe("jaccard", () => {
  test("identical sets = 1, disjoint = 0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  test("half overlap", () => {
    // {a,b,c} vs {a,b,d}: intersection 2, union 4 -> 0.5
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["a", "b", "d"]))).toBe(0.5);
  });
});

describe("containment", () => {
  test("is asymmetric: short query fully inside a long title scores 1", () => {
    const query = new Set(["wake", "sleep", "early"]);
    const title = new Set(["wake", "sleep", "early", "night", "owls", "late", "habits"]);
    expect(containment(query, title)).toBe(1);
    // ... while Jaccard on the same pair stays well below any dup threshold.
    expect(jaccard(query, title)).toBeLessThan(0.5);
    // The reverse direction is the title's containment, much lower.
    expect(containment(title, query)).toBeCloseTo(3 / 7);
  });

  test("partial overlap is the contained share of the first set", () => {
    // 2 of 3 query tokens found -> 0.67
    const q = new Set(["wake", "sleep", "deeply"]);
    const t = new Set(["wake", "sleep", "early"]);
    expect(containment(q, t)).toBeCloseTo(2 / 3);
  });

  test("empty sets score 0", () => {
    expect(containment(new Set(), new Set(["a"]))).toBe(0);
    expect(containment(new Set(["a"]), new Set())).toBe(0);
  });
});

// Build the (keyLabels, priors) ledger the new isDuplicate signature expects
// from one or more prior topics, using the topic text itself as the label.
function ledger(...topics: string[]) {
  const keyLabels = new Map<string, string>();
  const priors: { tokens: Set<string>; label: string }[] = [];
  for (const t of topics) {
    const n = normalizeTopic(t);
    keyLabels.set(n.key, t);
    priors.push({ tokens: n.tokens, label: t });
  }
  return { keyLabels, priors };
}

describe("isDuplicate", () => {
  test("exact key match is a duplicate, and reports what it matched", () => {
    const { keyLabels, priors } = ledger("how to sleep better tonight");
    const cand = normalizeTopic("how to sleep better tonight");
    const v = isDuplicate(cand, keyLabels, priors);
    expect(v.duplicate).toBe(true);
    expect(v.reason).toBe("exact-key");
    expect(v.matched).toBe("how to sleep better tonight");
  });

  test("high token overlap above threshold is a near-duplicate with a match", () => {
    const { keyLabels, priors } = ledger("secrets to staying focused while working from home");
    const cand = normalizeTopic("secrets to staying focused when working remotely");
    const v = isDuplicate(cand, keyLabels, priors, 0.5);
    expect(v.duplicate).toBe(true);
    expect(v.reason).toBe("similar");
    expect(v.matched).toBe("secrets to staying focused while working from home");
  });

  test("distinct topics are not duplicates", () => {
    const { keyLabels, priors } = ledger("waking up early every day");
    const cand = normalizeTopic("nutrition for distance runners");
    const v = isDuplicate(cand, keyLabels, priors, 0.5);
    expect(v.duplicate).toBe(false);
  });

  test("empty candidate is treated as a duplicate (rejected)", () => {
    const v = isDuplicate(normalizeTopic(""), new Map(), []);
    expect(v.duplicate).toBe(true);
    expect(v.reason).toBe("empty-after-normalize");
  });
});
