import { describe, expect, test } from "vitest";
import {
  classifyFailure,
  backoffDelayMs,
  circuitOnFailure,
  circuitOnSuccess,
  isCircuitOpen,
  CB_CLOSED,
  CB_THRESHOLD,
  CB_OPEN_MS,
  BACKOFF_CAP_MS,
} from "../src/pipeline/llm-policy";

describe("classifyFailure", () => {
  test("429 / 5xx / timeout / network are retryable", () => {
    expect(classifyFailure({ httpStatus: 429 })).toBe("retryable");
    expect(classifyFailure({ httpStatus: 500 })).toBe("retryable");
    expect(classifyFailure({ httpStatus: 503 })).toBe("retryable");
    expect(classifyFailure({ timedOut: true })).toBe("retryable");
    expect(classifyFailure({})).toBe("retryable"); // network / fetch threw
  });

  test("other 4xx are fatal (fail over, no retry)", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(classifyFailure({ httpStatus: s })).toBe("fatal");
    }
  });
});

describe("backoffDelayMs", () => {
  test("grows exponentially with rand=0", () => {
    const z = () => 0;
    expect(backoffDelayMs(0, z)).toBe(500);
    expect(backoffDelayMs(1, z)).toBe(1000);
    expect(backoffDelayMs(2, z)).toBe(2000);
  });

  test("caps at 8s plus bounded jitter", () => {
    expect(backoffDelayMs(10, () => 0)).toBe(BACKOFF_CAP_MS);
    expect(backoffDelayMs(10, () => 0.999)).toBeLessThan(BACKOFF_CAP_MS + 250);
  });

  test("jitter is additive", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(500 + 125);
  });
});

describe("circuit breaker", () => {
  const NOW = 1_000_000;

  test("closed circuit is not open", () => {
    expect(isCircuitOpen(CB_CLOSED, NOW)).toBe(false);
  });

  test("stays closed below threshold, opens at threshold for the window", () => {
    let s = CB_CLOSED;
    for (let i = 0; i < CB_THRESHOLD - 1; i++) s = circuitOnFailure(s, NOW);
    expect(isCircuitOpen(s, NOW)).toBe(false);
    s = circuitOnFailure(s, NOW); // threshold-th failure
    expect(s.fails).toBe(CB_THRESHOLD);
    expect(isCircuitOpen(s, NOW)).toBe(true);
    expect(isCircuitOpen(s, NOW + CB_OPEN_MS - 1)).toBe(true);
  });

  test("half-opens after the window", () => {
    let s = CB_CLOSED;
    for (let i = 0; i < CB_THRESHOLD; i++) s = circuitOnFailure(s, NOW);
    expect(isCircuitOpen(s, NOW + CB_OPEN_MS)).toBe(false);
  });

  test("success fully resets", () => {
    expect(circuitOnSuccess()).toEqual({ fails: 0, openedUntil: 0 });
  });

  test("failure during half-open re-opens", () => {
    let s = CB_CLOSED;
    for (let i = 0; i < CB_THRESHOLD; i++) s = circuitOnFailure(s, NOW);
    const later = NOW + CB_OPEN_MS + 1;
    s = circuitOnFailure(s, later);
    expect(isCircuitOpen(s, later)).toBe(true);
    expect(s.openedUntil).toBe(later + CB_OPEN_MS);
  });
});
