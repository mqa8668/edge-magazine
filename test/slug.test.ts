import { describe, expect, test } from "vitest";
import { slugify, isValidSlug } from "../src/lib/slug";

describe("slugify", () => {
  test("Vietnamese title -> no-dau hyphenated slug", () => {
    expect(slugify("Ngu du giac khong can 8 tieng")).toBe("ngu-du-giac-khong-can-8-tieng");
    expect(slugify("Doi moi thoi quen")).toBe("doi-moi-thoi-quen");
  });

  test("short titles are returned whole", () => {
    expect(slugify("Thoi quen buoi sang")).toBe("thoi-quen-buoi-sang");
  });

  test("truncation never cuts a token in half", () => {
    // The production bug: "...la-khoi-dau" was blind-cut to "...la-khoi-d".
    const title =
      "Ban mat gap doi thoi gian khi go bao cao tren dien thoai va do moi chi la khoi dau";
    const s = slugify(title);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
    expect(s.endsWith("-d")).toBe(false);
    expect(isValidSlug(s)).toBe(true);
    // the last token must be a complete word from the source title
    const words = title.toLowerCase().split(" ");
    expect(words).toContain(s.split("-").pop());
  });

  test("a cut landing exactly on a boundary keeps the whole last word", () => {
    // max lands right after "abc" -> the trailing hyphen path, not a mid-token cut
    expect(slugify("abc de", 3)).toBe("abc");
  });
});
