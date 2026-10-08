import { describe, expect, test } from "vitest";
import { pageToCategory, mergeDemand } from "../src/pipeline/gsc";

const CATS = new Set(["focus", "habits"]);

describe("pageToCategory", () => {
  test("routes an article URL to its category", () => {
    expect(pageToCategory("https://example.com/focus/deep-work-basics", CATS)).toBe("focus");
  });
  test("returns null for home, single-segment, prefixed, and unknown-category pages", () => {
    expect(pageToCategory("https://example.com/", CATS)).toBeNull();
    expect(pageToCategory("https://example.com/focus", CATS)).toBeNull(); // needs 2 segments
    expect(pageToCategory("https://example.com/tags/abc", CATS)).toBeNull(); // tags not a content category
    expect(pageToCategory("https://example.com/unknown/post", CATS)).toBeNull();
  });
  test("returns null on a malformed URL", () => {
    expect(pageToCategory("not a url", CATS)).toBeNull();
  });
});

describe("mergeDemand", () => {
  test("keeps primary first, dedups on the folded form, caps at max", () => {
    const out = mergeDemand(
      ["café focus tips", "morning routine"],
      ["cafe focus tips", "time blocking"], // first folds to a primary entry -> dropped
      10,
    );
    expect(out).toEqual(["café focus tips", "morning routine", "time blocking"]);
  });
  test("respects the cap", () => {
    const out = mergeDemand(["a one", "b two", "c three"], ["d four", "e five"], 2);
    expect(out).toEqual(["a one", "b two"]);
  });
});
