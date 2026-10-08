// LLM gateway (B5). Providers come from runtime config (llm.providerOrder /
// llm.models), each gets disciplined retries (backoff + jitter, retryable
// errors only), a per-provider circuit breaker persisted in KV, and every call
// is metered into llm_calls. A daily/monthly budget guard refuses new work
// (except admin test calls) once spend crosses the configured caps.
//
// Optional Cloudflare AI Gateway: set the AI_GATEWAY var ("accountId/gatewayId")
// and both DeepSeek and Workers AI route through it (dashboard analytics,
// caching, rate limits) with zero code changes elsewhere. Unset = direct.
//
// Callers depend only on chat(); the retry/breaker decision rules live in
// llm-policy.ts (pure, unit-tested).

import type { Bindings, WorkersAI } from "../env";
import { getConfig, type RuntimeConfig } from "../lib/runtime-config";
import { log, errStr } from "../lib/log";
import { sendAlert } from "../lib/alerts";
import { llmStats, recordLlmCall } from "./telemetry";
import {
  backoffDelayMs,
  circuitOnFailure,
  circuitOnSuccess,
  classifyFailure,
  isCircuitOpen,
  CB_CLOSED,
  type CircuitState,
} from "./llm-policy";

// Trace context so each provider attempt is attributable in llm_calls.
export interface LlmTrack {
  runId?: string;
  queueId?: number;
  stage: string; // ideation | draft | regen | critic | test
}

export interface ChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // ask the provider for a single JSON object
  track?: LlmTrack; // telemetry context (optional; falls back to stage "chat")
  // Per-call provider order override (else cfg.llm.providerOrder). Used by the
  // SEO tasks (clustering / internal linking), which prefer the free Groq tier
  // first and fall back to DeepSeek - short prompts, so Groq's length weakness
  // and tight TPM ceiling do not bite, and the calls cost nothing.
  providerOrder?: string[];
}

export interface TokenUsage {
  prompt?: number;
  completion?: number;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  usage?: TokenUsage;
}

// Thrown by the budget guard; runBatch treats it as a stop-the-run signal.
export class BudgetExceededError extends Error {
  constructor(
    public window: "daily" | "monthly",
    public spentUsd: number,
    public capUsd: number,
  ) {
    super(
      `LLM ${window} budget exceeded: spent $${spentUsd.toFixed(4)} >= cap $${capUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

// Provider-internal failure carrying what the retry policy needs.
class ProviderError extends Error {
  httpStatus?: number;
  timedOut?: boolean;
  constructor(message: string, opts: { httpStatus?: number; timedOut?: boolean } = {}) {
    super(message);
    this.httpStatus = opts.httpStatus;
    this.timedOut = opts.timedOut;
  }
}

interface AdapterResult {
  text: string;
  usage?: TokenUsage;
}

interface Adapter {
  name: string;
  model: string;
  call(opts: ChatOptions, timeoutMs: number): Promise<AdapterResult>;
}

// ── main entry ───────────────────────────────────────────────────────────────

export async function chat(env: Bindings, opts: ChatOptions): Promise<ChatResult> {
  const cfg = await getConfig(env);
  const stage = opts.track?.stage ?? "chat";

  // Budget gate. Admin one-off test calls stay allowed so a tripped budget can
  // still be diagnosed from /admin/tools.
  if (stage !== "test") await enforceBudget(env, cfg);

  const adapters = buildAdapters(env, cfg, opts.providerOrder);
  if (!adapters.length) {
    throw new Error(
      "no LLM provider configured (set DEEPSEEK_API_KEY, the AI binding, or openai-compat)",
    );
  }

  const errors: string[] = [];
  let attempt = 0;

  for (const adapter of adapters) {
    const cb = await readCircuit(env, adapter.name);
    if (isCircuitOpen(cb, Date.now())) {
      log.warn("llm.circuit_skip", { provider: adapter.name, openedUntil: cb.openedUntil });
      errors.push(`${adapter.name}: circuit open`);
      continue;
    }

    let lastErr: unknown = null;
    for (let retry = 0; retry <= cfg.llm.maxRetries; retry++) {
      attempt++;
      const t0 = Date.now();
      try {
        const r = await adapter.call(opts, cfg.llm.timeoutMs);
        await recordLlmCall(env, {
          runId: opts.track?.runId,
          queueId: opts.track?.queueId,
          stage,
          provider: adapter.name,
          model: adapter.model,
          ok: true,
          latencyMs: Date.now() - t0,
          promptTokens: r.usage?.prompt,
          completionTokens: r.usage?.completion,
          attempt,
          pricing: cfg.llm.pricing,
        });
        // Any success fully closes the breaker (also ends a half-open trial).
        if (cb.fails > 0 || cb.openedUntil > 0) {
          await writeCircuit(env, adapter.name, circuitOnSuccess());
        }
        return { text: r.text, provider: adapter.name, model: adapter.model, usage: r.usage };
      } catch (e) {
        lastErr = e;
        const pe = e instanceof ProviderError ? e : null;
        await recordLlmCall(env, {
          runId: opts.track?.runId,
          queueId: opts.track?.queueId,
          stage,
          provider: adapter.name,
          model: adapter.model,
          ok: false,
          error: errStr(e),
          latencyMs: Date.now() - t0,
          attempt,
          pricing: cfg.llm.pricing,
        });
        const kind = classifyFailure({
          httpStatus: pe?.httpStatus,
          timedOut: pe?.timedOut,
        });
        if (kind === "fatal") break; // wrong request for this provider - fail over now
        if (retry < cfg.llm.maxRetries) {
          const delay = backoffDelayMs(retry);
          log.warn("llm.retry", {
            provider: adapter.name,
            retry: retry + 1,
            delayMs: delay,
            err: errStr(e),
          });
          await sleep(delay);
        }
      }
    }

    // Provider given up on for this call -> advance its breaker.
    const next = circuitOnFailure(cb, Date.now());
    await writeCircuit(env, adapter.name, next);
    if (isCircuitOpen(next, Date.now())) {
      log.error("llm.circuit_open", { provider: adapter.name, fails: next.fails });
      await sendAlert(
        env,
        "provider-down",
        `LLM provider ${adapter.name}: circuit opened`,
        `${next.fails} consecutive failures; skipping it for 10 minutes. Last error: ${errStr(lastErr)}`,
      );
    }
    errors.push(`${adapter.name}: ${errStr(lastErr)}`);
  }

  throw new Error(`all LLM providers failed -> ${errors.join(" | ")}`);
}

// ── provider registry ────────────────────────────────────────────────────────

function buildAdapters(
  env: Bindings,
  cfg: RuntimeConfig,
  order?: string[],
): Adapter[] {
  const gateway = (env.AI_GATEWAY ?? "").trim(); // "accountId/gatewayId"
  const out: Adapter[] = [];
  for (const name of order && order.length ? order : cfg.llm.providerOrder) {
    if (name === "deepseek" && env.DEEPSEEK_API_KEY) {
      const url = gateway
        ? `https://gateway.ai.cloudflare.com/v1/${gateway}/deepseek/chat/completions`
        : "https://api.deepseek.com/chat/completions";
      out.push(
        openAiCompatAdapter("deepseek", cfg.llm.models.deepseek, url, env.DEEPSEEK_API_KEY),
      );
    } else if (name === "groq" && env.GROQ_API_KEY) {
      // Groq is OpenAI-compatible, so it reuses the same adapter as DeepSeek -
      // just a different base URL (optionally via the CF AI Gateway "groq" path).
      const url = gateway
        ? `https://gateway.ai.cloudflare.com/v1/${gateway}/groq/chat/completions`
        : "https://api.groq.com/openai/v1/chat/completions";
      out.push(openAiCompatAdapter("groq", cfg.llm.models.groq, url, env.GROQ_API_KEY));
    } else if (name === "workers-ai" && env.AI) {
      out.push(workersAiAdapter(env.AI, cfg.llm.models.workersAi, gateway.split("/")[1]));
    } else if (
      name === "openai-compat" &&
      env.OPENAI_COMPAT_API_KEY &&
      cfg.llm.openaiCompat.baseUrl &&
      cfg.llm.openaiCompat.model
    ) {
      const base = cfg.llm.openaiCompat.baseUrl.replace(/\/+$/, "");
      out.push(
        openAiCompatAdapter(
          "openai-compat",
          cfg.llm.openaiCompat.model,
          `${base}/chat/completions`,
          env.OPENAI_COMPAT_API_KEY,
        ),
      );
    }
  }
  return out;
}

// DeepSeek and any OpenAI-compatible endpoint share one adapter.
function openAiCompatAdapter(
  name: string,
  model: string,
  url: string,
  apiKey: string,
): Adapter {
  return {
    name,
    model,
    async call(opts, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: opts.system },
                { role: "user", content: opts.user },
              ],
              temperature: opts.temperature ?? 0.9,
              max_tokens: opts.maxTokens ?? 4096,
              ...(opts.json ? { response_format: { type: "json_object" } } : {}),
            }),
            signal: ctrl.signal,
          });
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") {
            throw new ProviderError(`timeout after ${timeoutMs}ms`, { timedOut: true });
          }
          throw new ProviderError(`network: ${errStr(e)}`);
        }
        if (!res.ok) {
          throw new ProviderError(
            `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
            { httpStatus: res.status },
          );
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (!text) throw new ProviderError("empty completion");
        return {
          text,
          usage: {
            prompt: data.usage?.prompt_tokens,
            completion: data.usage?.completion_tokens,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function workersAiAdapter(ai: WorkersAI, model: string, gatewayId?: string): Adapter {
  return {
    name: "workers-ai",
    model,
    async call(opts, timeoutMs) {
      // The binding has no abort signal; race a timeout so a hung call cannot
      // stall the whole run (the underlying request is simply abandoned).
      const run = ai.run(
        model,
        {
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          max_tokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature ?? 0.9,
        },
        gatewayId ? { gateway: { id: gatewayId } } : undefined,
      );
      const out = await Promise.race([
        run,
        sleep(timeoutMs).then(() => {
          throw new ProviderError(`timeout after ${timeoutMs}ms`, { timedOut: true });
        }),
      ]);
      const text = (out.response ?? "").trim();
      if (!text) throw new ProviderError("empty completion");
      const usage = (
        out as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      ).usage;
      return {
        text,
        usage: { prompt: usage?.prompt_tokens, completion: usage?.completion_tokens },
      };
    },
  };
}

// ── circuit breaker persistence (KV, cross-isolate) ─────────────────────────

const CB_KV_TTL_SECONDS = 3600; // consecutive-failure memory window

export async function readCircuit(env: Bindings, provider: string): Promise<CircuitState> {
  try {
    const raw = await env.CACHE_KV.get(`cb:${provider}`);
    if (!raw) return CB_CLOSED;
    const s = JSON.parse(raw) as Partial<CircuitState>;
    return {
      fails: typeof s.fails === "number" ? s.fails : 0,
      openedUntil: typeof s.openedUntil === "number" ? s.openedUntil : 0,
    };
  } catch {
    return CB_CLOSED; // fail open: a broken KV must not block providers
  }
}

async function writeCircuit(
  env: Bindings,
  provider: string,
  state: CircuitState,
): Promise<void> {
  try {
    if (state.fails === 0 && state.openedUntil === 0) {
      await env.CACHE_KV.delete(`cb:${provider}`);
    } else {
      await env.CACHE_KV.put(`cb:${provider}`, JSON.stringify(state), {
        expirationTtl: CB_KV_TTL_SECONDS,
      });
    }
  } catch (e) {
    log.warn("llm.circuit_persist_failed", { provider, err: errStr(e) });
  }
}

// ── budget guard ─────────────────────────────────────────────────────────────
// Spend is summed from llm_calls (24h / 30d) and cached per isolate for 5
// minutes - cheap, and precise enough for a hard brake. A cap of 0 disables
// that window's check.

let budgetCache: { at: number; dayMicros: number; monthMicros: number } | null = null;

async function enforceBudget(env: Bindings, cfg: RuntimeConfig): Promise<void> {
  const dayCap = cfg.llm.dailyBudgetUsd;
  const monthCap = cfg.llm.monthlyBudgetUsd;
  if (dayCap <= 0 && monthCap <= 0) return;

  const now = Date.now();
  if (!budgetCache || now - budgetCache.at > 5 * 60_000) {
    const [day, month] = await Promise.all([
      llmStats(env, now - 24 * 60 * 60_000),
      llmStats(env, now - 30 * 24 * 60 * 60_000),
    ]);
    budgetCache = { at: now, dayMicros: day.costMicros, monthMicros: month.costMicros };
  }

  const exceeded: ["daily" | "monthly", number, number] | null =
    dayCap > 0 && budgetCache.dayMicros >= dayCap * 1e6
      ? ["daily", budgetCache.dayMicros / 1e6, dayCap]
      : monthCap > 0 && budgetCache.monthMicros >= monthCap * 1e6
        ? ["monthly", budgetCache.monthMicros / 1e6, monthCap]
        : null;

  if (exceeded) {
    const [window, spent, cap] = exceeded;
    log.error("llm.budget_exceeded", { window, spentUsd: spent, capUsd: cap });
    await sendAlert(
      env,
      "budget-exceeded",
      `LLM budget exceeded (${window})`,
      `spent $${spent.toFixed(4)} >= cap $${cap.toFixed(4)}. Article generation is paused until older spend ages out or the cap is raised in /admin/config.`,
    );
    throw new BudgetExceededError(window, spent, cap);
  }
}

// Test-only: force a fresh budget read on the next call.
export function _resetBudgetCache(): void {
  budgetCache = null;
}

// ── shared helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extract JSON from a completion that may be fenced or prefixed with prose.
export function parseJsonObject<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object in completion");
  }
  return JSON.parse(body.slice(start, end + 1)) as T;
}
