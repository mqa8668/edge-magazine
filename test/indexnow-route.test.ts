import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { indexNowKeyRoute } from "../src/seo/indexnow";

function app() {
  const a = new Hono<any>();
  a.get("/robots.txt", (c) => c.text("robots"));
  a.get("/:file{[A-Za-z0-9_-]+\\.txt}", indexNowKeyRoute);
  return a;
}

describe("indexNowKeyRoute", () => {
  it("serves the key only when it matches", async () => {
    const env = { INDEXNOW_KEY: "abc123" };
    const ok = await app().request("/abc123.txt", {}, env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc123");
    expect((await app().request("/other.txt", {}, env)).status).toBe(404);
    expect(await (await app().request("/robots.txt", {}, env)).text()).toBe("robots");
  });
  it("404s when no key is configured", async () => {
    expect((await app().request("/.txt", {}, {})).status).toBe(404);
    expect((await app().request("/x.txt", {}, { INDEXNOW_KEY: "" })).status).toBe(404);
  });
});
