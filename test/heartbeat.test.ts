import { describe, expect, test } from "vitest";
import { formatDigest, type HealthData } from "../src/pipeline/heartbeat";

// A fully-green baseline; each test perturbs one field to assert the status
// logic and the rendered lines.
function healthy(overrides: Partial<HealthData> = {}): HealthData {
  return {
    checks: { db: true, kv: true, r2: true },
    runs24h: { total: 3, cron: 1, published: 3, failed: 0, anyFailed: false },
    lastGoodAgeH: 3.2,
    stale: false,
    posts: { total: 62, last24h: 3 },
    queue: { pending: 0, failed: 8, published: 60 },
    llm: { calls24h: 14, cost24h: 0.03, costMtd: 0.41, monthlyBudget: 20 },
    openProviders: [],
    config: { pipelineEnabled: true, postsPerDay: 3, publishMode: "auto", channels: ["telegram"] },
    ...overrides,
  };
}

describe("formatDigest status", () => {
  test("all green -> OK", () => {
    const { status, text } = formatDigest(healthy());
    expect(status).toBe("OK");
    expect(text).toContain("[Edge Magazine] System health: OK");
    expect(text).toContain("Providers: all OK");
  });

  test("infra probe failure -> DOWN", () => {
    expect(formatDigest(healthy({ checks: { db: false, kv: true, r2: true } })).status).toBe("DOWN");
  });

  test("stale (no good run in window) -> DOWN", () => {
    const { status, text } = formatDigest(healthy({ stale: true, lastGoodAgeH: 40 }));
    expect(status).toBe("DOWN");
    expect(text).toContain("(STALE)");
  });

  test("no good run at all -> DOWN and reports NONE", () => {
    const { status, text } = formatDigest(healthy({ stale: true, lastGoodAgeH: null }));
    expect(status).toBe("DOWN");
    expect(text).toContain("Last good run: NONE");
  });

  test("a failed run in 24h -> WARN", () => {
    expect(formatDigest(healthy({ runs24h: { total: 3, cron: 1, published: 2, failed: 1, anyFailed: true } })).status).toBe("WARN");
  });

  test("open circuit breaker -> WARN and lists provider", () => {
    const { status, text } = formatDigest(healthy({ openProviders: ["groq"] }));
    expect(status).toBe("WARN");
    expect(text).toContain("Providers: circuit OPEN - groq");
  });

  test("monthly budget exceeded -> WARN", () => {
    expect(formatDigest(healthy({ llm: { calls24h: 14, cost24h: 0.03, costMtd: 21, monthlyBudget: 20 } })).status).toBe("WARN");
  });

  test("kill switch off -> WARN", () => {
    const { status, text } = formatDigest(
      healthy({ config: { pipelineEnabled: false, postsPerDay: 3, publishMode: "auto", channels: ["telegram"] } }),
    );
    expect(status).toBe("WARN");
    expect(text).toContain("pipeline OFF");
  });

  test("auto mode but nothing published in 24h -> WARN", () => {
    expect(formatDigest(healthy({ posts: { total: 62, last24h: 0 } })).status).toBe("WARN");
  });

  test("auto mode below the daily target (1 of 3) -> WARN with BELOW TARGET", () => {
    const { status, text } = formatDigest(healthy({ posts: { total: 62, last24h: 1 } }));
    expect(status).toBe("WARN");
    expect(text).toContain("+1 in 24h / target 3 (BELOW TARGET)");
  });

  test("on-target day renders the target without the warning marker", () => {
    const { status, text } = formatDigest(healthy());
    expect(status).toBe("OK");
    expect(text).toContain("+3 in 24h / target 3");
    expect(text).not.toContain("BELOW TARGET");
  });

  test("review mode with 0 published is NOT a warning", () => {
    const { status } = formatDigest(
      healthy({
        posts: { total: 62, last24h: 0 },
        config: { pipelineEnabled: true, postsPerDay: 3, publishMode: "review", channels: ["telegram"] },
      }),
    );
    expect(status).toBe("OK");
  });

  test("queue backlog piling up -> WARN", () => {
    expect(formatDigest(healthy({ queue: { pending: 12, failed: 8, published: 60 } })).status).toBe("WARN");
  });
});
