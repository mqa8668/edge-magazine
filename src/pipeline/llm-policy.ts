// Pure retry / circuit-breaker policy for the LLM gateway. No imports, no I/O -
// deliberately isolated so it can be unit-tested with plain node
// (scripts/test-llm-policy.mjs) and reused by vitest in B6. The gateway
// (llm.ts) owns all side effects (fetch, KV, telemetry); this module only
// answers "should we retry / is the circuit open / what state comes next".

// ── failure classification ───────────────────────────────────────────────────

export type FailureKind = "retryable" | "fatal";

// Retry on rate limits (429), server errors (5xx), timeouts, and network drops.
// Any other HTTP status (400/401/403/404/422...) means the request itself is
// wrong for this provider - retrying wastes budget, so fail over immediately.
export function classifyFailure(input: {
  httpStatus?: number;
  timedOut?: boolean;
}): FailureKind {
  if (input.timedOut) return "retryable";
  const s = input.httpStatus;
  if (s === undefined) return "retryable"; // network error / fetch threw
  if (s === 429 || s >= 500) return "retryable";
  return "fatal";
}

// ── backoff ──────────────────────────────────────────────────────────────────

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;
export const BACKOFF_JITTER_MS = 250;

// Exponential backoff with jitter: 500ms * 2^n + rand(0..250), capped at 8s.
// `rand` is injectable for deterministic tests.
export function backoffDelayMs(attemptIndex: number, rand: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS * 2 ** Math.max(0, attemptIndex);
  return Math.min(base, BACKOFF_CAP_MS) + Math.floor(rand() * BACKOFF_JITTER_MS);
}

// ── circuit breaker ──────────────────────────────────────────────────────────
// One breaker per provider, persisted in KV (cb:<provider>) so the count of
// consecutive failures survives across isolates and cron fires. After
// CB_THRESHOLD consecutive provider-level failures the circuit opens for
// CB_OPEN_MS; once that window passes the next call is the half-open trial
// (isCircuitOpen returns false), and its outcome either resets or re-opens.

export const CB_THRESHOLD = 5;
export const CB_OPEN_MS = 10 * 60_000;

export interface CircuitState {
  fails: number; // consecutive provider-level failures
  openedUntil: number; // epoch ms; 0 = closed
}

export const CB_CLOSED: CircuitState = { fails: 0, openedUntil: 0 };

export function isCircuitOpen(state: CircuitState, now: number): boolean {
  return state.openedUntil > now;
}

// A provider-level success (any successful attempt) fully closes the circuit.
export function circuitOnSuccess(): CircuitState {
  return CB_CLOSED;
}

// A provider-level failure = the provider was given up on for this chat() call
// (all its retries exhausted, or a fatal error). Returns the next state; the
// circuit (re)opens when the consecutive count reaches the threshold.
export function circuitOnFailure(prev: CircuitState, now: number): CircuitState {
  const fails = prev.fails + 1;
  if (fails >= CB_THRESHOLD) {
    return { fails, openedUntil: now + CB_OPEN_MS };
  }
  return { fails, openedUntil: 0 };
}
