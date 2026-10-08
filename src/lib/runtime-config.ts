// Runtime operating config, stored as a single JSON blob in KV (key `cfg:v1`)
// and deep-merged over code defaults. This is what lets the pipeline be tuned
// (cadence, kill switch, budgets, thresholds) WITHOUT a redeploy. Secrets and
// URLs stay in env vars; only operational knobs live here.
//
// SAFE DEFAULTS for a fresh install: the drafting pipeline is OFF, publishes
// nothing without review, uses only Workers AI, and has no external site ids.
// Turn things on deliberately from the admin config page.

import type { Bindings } from "../env";
import { log, errStr } from "./log";
import {
  DEFAULT_HOUSE_VOICE,
  DEFAULT_TONE_CARD,
  DEFAULT_PERSONA_SEEDS,
} from "../pipeline/prompts";

export interface ModelPricing {
  inPerM: number; // USD per 1,000,000 prompt tokens
  outPerM: number; // USD per 1,000,000 completion tokens
}

export interface RuntimeConfig {
  pipeline: {
    enabled: boolean; // master kill switch for the scheduled runs + /api/run (default off)
    postsPerDay: number;
    backfillCount: number;
    maxGenAttempts: number; // LLM regenerate cap per article
    timeBudgetMs: number; // stop a run early past this wall-clock budget
  };
  publish: {
    mode: "auto" | "review"; // auto = self-publish; review = hold drafts for admin approval
  };
  quality: {
    minWords: number; // quality floor: below this the draft gets repaired
    // Salvage floor. A draft whose ONLY complaint is length and that still
    // clears this bar is published (with a warn) instead of failing the item -
    // losing a whole day's slot over a handful of words is a worse outcome than
    // a slightly short but sound article. Everything else (thin structure,
    // safety, empty body) still fails. Set to 0 to disable salvaging.
    hardMinWords: number;
    similarityThreshold: number; // Jaccard dedup threshold
    criticEnabled: boolean; // extra LLM critic pass
    criticMinScore: number;
  };
  llm: {
    // Tried in order. A provider other than "workers-ai" is used only when it is
    // listed here AND its secret is set: "deepseek" | "groq" | "openai-compat".
    providerOrder: string[];
    models: { deepseek: string; workersAi: string; groq: string };
    timeoutMs: number;
    maxRetries: number; // extra attempts per provider on retryable errors
    dailyBudgetUsd: number; // hard spend caps enforced by the gateway
    monthlyBudgetUsd: number;
    pricing: Record<string, ModelPricing>; // cost estimation
    // Generic OpenAI-compatible endpoint (Groq/OpenRouter/...). Active only when
    // baseUrl + model are set here AND the OPENAI_COMPAT_API_KEY secret exists.
    openaiCompat: { baseUrl: string; model: string };
  };
  photos: {
    providerOrder: string[]; // stock photo providers, tried in order ("pexels"; needs PEXELS_API_KEY)
  };
  alerts: {
    enabled: boolean;
    channels: string[]; // subset of ["email", "telegram"]
    failRateThreshold: number; // failed/requested above this alerts (cron only)
    staleRunHours: number; // watchdog: no good run within this many hours alerts
  };
  // Content safety gate (src/pipeline/safety.ts). HARD hits never publish; more
  // than softThreshold distinct SOFT hits trigger a regenerate. Admin can extend
  // the term lists / idiom whitelist here without a redeploy.
  safety: {
    enabled: boolean;
    softThreshold: number; // max distinct SOFT hits before a draft fails
    extraHardTerms: string[]; // added to the built-in HARD lists
    extraSoftTerms: string[]; // added to the built-in SOFT lists
    allowPhrases: string[]; // extra benign idioms to whitelist
  };
  // Editable prompt layers the article system message is composed from
  // (src/pipeline/prompts.ts). A blank field falls back to its DEFAULT_* code
  // constant, so the pipeline can never ship an empty system prompt. Tuning the
  // house voice / tone / an author's voice needs no redeploy.
  prompts: {
    houseVoice: string; // system-prompt core (DEFAULT_HOUSE_VOICE)
    toneCard: string; // tone + content-safety card (DEFAULT_TONE_CARD)
    personas: Record<string, string>; // author slug -> voice seed
  };
  // On-page SEO automation (topic clusters + in-body internal linking). These
  // LLM calls are short (classify / pick anchor phrases); llmProviderOrder sets
  // their provider order independently of the main content providerOrder.
  seo: {
    llmProviderOrder: string[]; // provider order for cluster/link LLM calls
    internalLinking: {
      enabled: boolean;
      maxLinks: number; // hard cap on in-body links added per article
      candidatePool: number; // how many related posts the LLM chooses from
    };
    clustering: {
      enabled: boolean;
      maxClusters: number; // ceiling on distinct clusters (keeps them meaningful)
    };
    // Optional Google Search Console demand source (src/pipeline/gsc.ts): proven
    // queries the site already gets impressions for, routed to their ranking
    // page's category and merged into ideation. Needs the GSC_SA_KEY secret and
    // your own siteUrl. Off by default.
    gsc: {
      enabled: boolean;
      siteUrl: string; // your Search Console property id (e.g. sc-domain:example.com)
      lookbackDays: number; // query window
      minImpressions: number; // ignore near-zero-impression noise
      positionMin: number; // only feed queries ranked >= this (room to grow)
      maxPerCategory: number; // cap on GSC queries fed per category
      cacheDays: number; // KV TTL for the demand map
      rowLimit: number; // Search Analytics rows requested
    };
  };
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  pipeline: {
    enabled: false,
    postsPerDay: 1,
    backfillCount: 30,
    maxGenAttempts: 3,
    timeBudgetMs: 25_000,
  },
  publish: { mode: "review" },
  quality: {
    minWords: 600,
    hardMinWords: 500,
    similarityThreshold: 0.5,
    criticEnabled: false,
    criticMinScore: 6,
  },
  llm: {
    providerOrder: ["workers-ai"],
    models: {
      deepseek: "deepseek-chat",
      // Default provider. Cloudflare retires models over time; if calls start
      // failing with a model error, check the current Workers AI catalogue.
      workersAi: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      // Groq (OpenAI-compatible). Used only if "groq" is in providerOrder and
      // GROQ_API_KEY is set. Pick a model whose rate limits fit a full article prompt.
      groq: "llama-3.3-70b-versatile",
    },
    timeoutMs: 90_000,
    maxRetries: 2,
    dailyBudgetUsd: 1.0,
    monthlyBudgetUsd: 20.0,
    pricing: {
      "deepseek-chat": { inPerM: 0.27, outPerM: 1.1 },
      // Priced at 0 on the assumption of a free tier, which keeps those calls
      // off the budget guard. On a paid plan set the real rate so spend is metered.
      "llama-3.3-70b-versatile": { inPerM: 0, outPerM: 0 },
      // Workers AI (billed in Neurons). Without an entry, costMicros() falls back
      // to 0 and spend is invisible to the budget guard. ESTIMATE - verify against
      // Cloudflare's current model rate and tune.
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 0.29, outPerM: 2.25 },
    },
    openaiCompat: { baseUrl: "", model: "" },
  },
  photos: { providerOrder: ["pexels"] },
  alerts: {
    enabled: true,
    channels: ["email"],
    failRateThreshold: 0.5,
    staleRunHours: 26,
  },
  safety: {
    enabled: true,
    softThreshold: 2,
    extraHardTerms: [],
    extraSoftTerms: [],
    allowPhrases: [],
  },
  prompts: {
    houseVoice: DEFAULT_HOUSE_VOICE,
    toneCard: DEFAULT_TONE_CARD,
    personas: { ...DEFAULT_PERSONA_SEEDS },
  },
  seo: {
    llmProviderOrder: ["workers-ai"],
    internalLinking: { enabled: true, maxLinks: 3, candidatePool: 10 },
    clustering: { enabled: true, maxClusters: 24 },
    gsc: {
      enabled: false,
      siteUrl: "",
      lookbackDays: 90,
      minImpressions: 3,
      positionMin: 5,
      maxPerCategory: 15,
      cacheDays: 7,
      rowLimit: 1000,
    },
  },
};

const KV_KEY = "cfg:v1";
const CACHE_TTL_MS = 60_000;

// Per-isolate cache so a burst of requests does not read KV each time.
let cache: { at: number; cfg: RuntimeConfig } | null = null;

// Read the effective config: code defaults deep-merged with the KV override.
// Falls back to defaults on any KV/parse error (config must never hard-fail a
// request or the cron).
export async function getConfig(env: Bindings): Promise<RuntimeConfig> {
  const nowMs = Date.now();
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.cfg;

  let cfg = DEFAULT_CONFIG;
  try {
    const raw = await env.CACHE_KV.get(KV_KEY);
    if (raw) cfg = deepMerge(DEFAULT_CONFIG, JSON.parse(raw)) as RuntimeConfig;
  } catch (e) {
    log.warn("config.read_failed", { err: errStr(e) });
    cfg = DEFAULT_CONFIG;
  }
  cache = { at: nowMs, cfg };
  return cfg;
}

// Read the current stored override (or {} if none) WITHOUT the isolate cache -
// used by setConfig to compute an authoritative diff.
async function readRaw(env: Bindings): Promise<Partial<RuntimeConfig>> {
  try {
    const raw = await env.CACHE_KV.get(KV_KEY);
    return raw ? (JSON.parse(raw) as Partial<RuntimeConfig>) : {};
  } catch {
    return {};
  }
}

// Apply a partial patch: merge over the current effective config, persist the
// FULL result to KV, write a config_audit diff row, and bust the isolate cache.
// Used by the admin config form; the KV key can also be set directly via `wrangler kv key put`.
export async function setConfig(
  env: Bindings,
  patch: DeepPartial<RuntimeConfig>,
  actor: string,
): Promise<{ config: RuntimeConfig; diff: ConfigDiff }> {
  const before = deepMerge(DEFAULT_CONFIG, await readRaw(env)) as RuntimeConfig;
  const after = deepMerge(before, patch) as RuntimeConfig;
  const diff = configDiff(before, after);

  await env.CACHE_KV.put(KV_KEY, JSON.stringify(after));
  cache = { at: Date.now(), cfg: after };

  if (Object.keys(diff).length) {
    try {
      await env.DB.prepare(
        "INSERT INTO config_audit (changed_at, actor, diff_json) VALUES (?, ?, ?)",
      )
        .bind(Date.now(), actor, JSON.stringify(diff))
        .run();
    } catch (e) {
      log.warn("config.audit_write_failed", { err: errStr(e) });
    }
    log.info("config.change", { actor, keys: Object.keys(diff) });
  }
  return { config: after, diff };
}

// Whether a KV override currently exists (health reporting).
export async function configSource(env: Bindings): Promise<"kv" | "default"> {
  try {
    return (await env.CACHE_KV.get(KV_KEY)) ? "kv" : "default";
  } catch {
    return "default";
  }
}

// Test-only: drop the isolate cache so a freshly written KV value is picked up.
export function _resetConfigCache(): void {
  cache = null;
}

// ── merge + diff helpers ─────────────────────────────────────────────────────

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type ConfigDiff = Record<string, { from: unknown; to: unknown }>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recursive merge: objects merge key-by-key; arrays and scalars from the source
// replace the base (so providerOrder/channels are set wholesale, not appended).
function deepMerge(base: unknown, src: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(src)) return src ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Flatten to dotted leaf paths and report only changed leaves.
function configDiff(before: unknown, after: unknown, prefix = ""): ConfigDiff {
  const diff: ConfigDiff = {};
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      Object.assign(
        diff,
        configDiff(before[k], after[k], prefix ? `${prefix}.${k}` : k),
      );
    }
    return diff;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    diff[prefix] = { from: before, to: after };
  }
  return diff;
}
