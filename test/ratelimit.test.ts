import { describe, expect, test } from "vitest";
import { rateLimit, clientIp } from "../src/lib/ratelimit";
import { fakeEnv } from "./helpers";
import type { Bindings } from "../src/env";

describe("rateLimit", () => {
  test("allows up to the limit, then blocks with a retry-after", async () => {
    const env = fakeEnv() as unknown as Bindings;
    for (let i = 0; i < 5; i++) {
      const r = await rateLimit(env, "test", "ip1", 5, 600);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(5 - (i + 1));
    }
    const blocked = await rateLimit(env, "test", "ip1", 5, 600);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("separate keys have independent budgets", async () => {
    const env = fakeEnv() as unknown as Bindings;
    for (let i = 0; i < 5; i++) await rateLimit(env, "test", "a", 5, 600);
    const other = await rateLimit(env, "test", "b", 5, 600);
    expect(other.allowed).toBe(true);
  });

  test("separate scopes have independent budgets", async () => {
    const env = fakeEnv() as unknown as Bindings;
    for (let i = 0; i < 5; i++) await rateLimit(env, "login", "ip", 5, 600);
    const api = await rateLimit(env, "api", "ip", 5, 600);
    expect(api.allowed).toBe(true);
  });

  test("fails open when KV throws (never lock the caller out)", async () => {
    const env = {
      CACHE_KV: {
        get() {
          throw new Error("kv down");
        },
        put: async () => {},
      },
    } as unknown as Bindings;
    const r = await rateLimit(env, "test", "ip", 1, 600);
    expect(r.allowed).toBe(true);
  });
});

describe("clientIp", () => {
  test("prefers CF-Connecting-IP", () => {
    const req = new Request("https://x.test", {
      headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  test("falls back to the first x-forwarded-for hop", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "5.5.5.5, 6.6.6.6" },
    });
    expect(clientIp(req)).toBe("5.5.5.5");
  });

  test("defaults to 'local' with no headers", () => {
    expect(clientIp(new Request("https://x.test"))).toBe("local");
  });
});
