import { describe, expect, test } from "vitest";
import {
  planStyle,
  planBatch,
  leastCoveredCategory,
  PERSONAS,
} from "../src/pipeline/rotation";

const CATS = ["habits", "focus", "systems"];

describe("planStyle", () => {
  test("is deterministic for the same (index, category)", () => {
    expect(planStyle(3, "habits")).toEqual(planStyle(3, "habits"));
  });

  test("assigns a known persona and the category", () => {
    const s = planStyle(0, "habits");
    expect(s.categorySlug).toBe("habits");
    expect(PERSONAS[s.personaSlug]).toBeDefined();
  });

  test("advancing the index rotates the assignment", () => {
    const seen = new Set(
      [0, 1, 2, 3].map((i) => JSON.stringify(planStyle(i, "focus"))),
    );
    expect(seen.size).toBeGreaterThan(1); // not all identical
  });
});

describe("leastCoveredCategory", () => {
  test("picks the category with the fewest posts", () => {
    expect(leastCoveredCategory({ a: 5, b: 1, c: 3 }, ["a", "b", "c"])).toBe("b");
  });

  test("treats a missing category as zero coverage", () => {
    expect(leastCoveredCategory({ a: 2 }, ["a", "b"])).toBe("b");
  });
});

describe("planBatch", () => {
  test("produces exactly count assignments", () => {
    const out = planBatch({ categories: CATS, coverage: {}, count: 6 });
    expect(out).toHaveLength(6);
  });

  test("balances toward least-covered categories", () => {
    const out = planBatch({ categories: CATS, coverage: {}, count: 6 });
    const counts: Record<string, number> = {};
    for (const a of out) counts[a.categorySlug] = (counts[a.categorySlug] ?? 0) + 1;
    // 6 across 3 empty categories -> 2 each.
    expect(counts).toEqual({ habits: 2, focus: 2, systems: 2 });
  });

  test("fills the most-behind category first", () => {
    const out = planBatch({
      categories: CATS,
      coverage: { habits: 10, focus: 10, systems: 0 },
      count: 2,
    });
    expect(out.every((a) => a.categorySlug === "systems")).toBe(true);
  });

  test("staggers the first assignment across categories (not all same persona)", () => {
    const out = planBatch({ categories: CATS, coverage: {}, count: 3 });
    const personas = new Set(out.map((a) => a.personaSlug));
    expect(personas.size).toBeGreaterThan(1);
  });
});
