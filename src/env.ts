// Worker runtime bindings (wrangler.toml) + non-secret vars + secrets.
// `wrangler types` can regenerate a fuller version into worker-configuration.d.ts;
// this hand-written interface is what app code imports.

// Workers AI binding (fallback LLM provider). Minimal shape; see src/pipeline/llm.ts.
// The optional third argument routes the call through Cloudflare AI Gateway.
export interface WorkersAI {
  run(
    model: string,
    input: unknown,
    options?: { gateway?: { id: string } },
  ): Promise<{ response?: string; [k: string]: unknown }>;
}

// A unit of background content work, consumed by the queue handler. Defined here
// (a dependency-free module) so both env bindings and the generator can import it
// without a cycle. Each message produces exactly one pipeline_runs row, whose id
// is created synchronously by the admin route (so it can redirect to the run
// page) and passed through here.
export type GenerateJob =
  | { kind: "item"; runId: string; startedAt: number; queueId: number }
  | { kind: "batch"; runId: string; startedAt: number; count: number };

export interface Bindings {
  // Resource bindings
  DB: D1Database;
  CACHE_KV: KVNamespace;
  UPLOADS: R2Bucket;
  AI?: WorkersAI; // Cloudflare Workers AI (fallback LLM)
  GENERATE_QUEUE?: Queue<GenerateJob>; // background content generation

  // Public, non-secret vars (wrangler.toml [vars])
  SITE_URL: string;
  SITE_NAME: string;
  CONTACT_EMAIL?: string; // public contact mailbox (empty = contact blocks hidden)
  GA4_ID: string;
  GTM_ID: string;
  ADSENSE_PUBLISHER_ID: string;
  CF_BEACON_TOKEN?: string; // Cloudflare Web Analytics beacon token (empty/unset = off)
  POSTS_PER_DAY?: string; // content pipeline cadence (default 2; fallback for config KV)
  BACKFILL_COUNT?: string; // one-time backfill size (default 30; fallback for config KV)

  // Alerting (B3) - non-secret vars.
  ALERT_EMAIL?: string; // ops alert recipient (Resend "to")
  ALERT_EMAIL_FROM?: string; // verified Resend sender, e.g. "Edge Magazine <alerts@example.com>"

  // LLM gateway (B5) - non-secret var. "accountId/gatewayId" of a Cloudflare AI
  // Gateway; when set, DeepSeek + Workers AI calls route through it (analytics,
  // caching, rate limits on the CF dashboard). Empty/unset = direct calls.
  AI_GATEWAY?: string;

  // Turnstile (B6) - newsletter form anti-bot. Site key is a public var; the
  // secret is set via `wrangler secret put`. Unset = widget hidden + skip check.
  TURNSTILE_SITE_KEY?: string;
  INDEXNOW_KEY?: string; // IndexNow key (public); pings Bing/Yandex/Seznam on publish

  // Secrets (set via `wrangler secret put`) - optional until configured.
  PUBLISH_TOKEN?: string;
  RESEND_API_KEY?: string; // transactional email (alerts, newsletter)
  DEEPSEEK_API_KEY?: string; // primary LLM provider
  GROQ_API_KEY?: string; // Groq (OpenAI-compatible, fast) LLM provider
  PEXELS_API_KEY?: string; // stock photos
  TELEGRAM_BOT_TOKEN?: string; // alert channel (optional)
  TELEGRAM_CHAT_ID?: string; // alert channel target (optional)
  ADMIN_PASSWORD_HASH?: string; // /admin login (generate: npm run admin:hash)
  SESSION_SECRET?: string; // /admin session + CSRF HMAC key
  OPENAI_COMPAT_API_KEY?: string; // key for the generic openai-compat provider (B5)
  GSC_SA_KEY?: string; // Google Search Console service-account JSON (search-demand source, gsc.ts)
  TURNSTILE_SECRET_KEY?: string; // Turnstile server-side verify secret (B6)
}

export type AppEnv = { Bindings: Bindings };
