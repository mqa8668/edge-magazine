// Ops alerting. Two channels (email via Resend, Telegram), both optional and
// toggled in runtime config (alerts.channels). Every send is best-effort and
// deduped: the same alert type is suppressed for 6h via a KV marker, so a
// recurring failure does not spam. Alerts fire only for cron-triggered runs and
// the watchdog - manual/backfill runs are assumed to be admin-supervised.

import type { Bindings } from "../env";
import { getConfig, type RuntimeConfig } from "./runtime-config";
import { log, errStr } from "./log";
import { hungRuns, lastGoodRun, markRunFailed, recordNotification } from "../pipeline/telemetry";
import type { RunReport } from "../pipeline/generate";

const DEDUP_TTL_SECONDS = 6 * 60 * 60; // 6h

export type AlertType =
  | "run-crashed"
  | "topup-crashed" // the 15:00 top-up cron crashed (src/index.ts)
  | "empty-run"
  | "high-fail-rate"
  | "stale-run"
  | "budget-exceeded" // raised by B5
  | "provider-down"; // raised by B5

// error = needs attention now; warn = degraded; the rest are informational.
const ALERT_SEVERITY: Record<AlertType, "info" | "warn" | "error"> = {
  "run-crashed": "error",
  "topup-crashed": "error",
  "stale-run": "error",
  "provider-down": "error",
  "budget-exceeded": "warn",
  "empty-run": "warn",
  "high-fail-rate": "warn",
};

// Send an alert on every enabled channel, unless the same type fired < 6h ago.
// `href` deep-links the in-app notification (e.g. to the failing run).
// `dedupSuffix` splits one type into independent dedup buckets: without it, a
// type that covers several subjects (e.g. one per provider) would let the
// first failure suppress every other subject's alert for the whole 6h window -
// silence that looks exactly like health.
export async function sendAlert(
  env: Bindings,
  type: AlertType,
  subject: string,
  body: string,
  href?: string,
  dedupSuffix?: string,
): Promise<void> {
  const cfg = await getConfig(env);
  if (!cfg.alerts.enabled) return;

  const dedupKey = `alert:${type}${dedupSuffix ? `:${dedupSuffix}` : ""}`;
  try {
    if (await env.CACHE_KV.get(dedupKey)) {
      log.info("alert.suppressed", { type });
      return;
    }
  } catch {
    // If the dedup read fails, still try to send (better a dup than silence).
  }

  const site = env.SITE_NAME || "Edge Magazine";
  const line = `[${site}] ${subject}`;
  const channels = new Set(cfg.alerts.channels);
  const results: string[] = [];

  // In-app feed (topbar bell + /admin/alerts). Written once per dedup window,
  // same as the outbound channels; independent of whether email/telegram are on.
  await recordNotification(env, {
    kind: type,
    severity: ALERT_SEVERITY[type] ?? "warn",
    title: subject,
    body,
    href,
  });

  if (channels.has("email")) {
    results.push(`email:${await sendEmail(env, line, body)}`);
  }
  if (channels.has("telegram")) {
    results.push(`telegram:${await sendTelegram(env, `${line}\n\n${body}`)}`);
  }

  log.warn("alert.sent", { type, subject, results });
  try {
    await env.CACHE_KV.put(dedupKey, String(Date.now()), {
      expirationTtl: DEDUP_TTL_SECONDS,
    });
  } catch {
    // Non-fatal: worst case the next occurrence sends again.
  }
}

async function sendEmail(env: Bindings, subject: string, text: string): Promise<string> {
  if (!env.RESEND_API_KEY) return "skip(no-key)";
  if (!env.ALERT_EMAIL) return "skip(no-recipient)";
  const from = env.ALERT_EMAIL_FROM || defaultFrom(env);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from, to: env.ALERT_EMAIL, subject, text }),
    });
    if (!res.ok) return `err(${res.status})`;
    return "ok";
  } catch (e) {
    log.warn("alert.email_failed", { err: errStr(e) });
    return "err(throw)";
  }
}

// Exported so the ops heartbeat (src/pipeline/heartbeat.ts) and the admin
// "test Telegram" button can push a message directly, bypassing sendAlert's
// severity/dedup machinery (a daily health digest must never be suppressed).
export async function sendTelegram(env: Bindings, text: string): Promise<string> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return "skip(unconfigured)";
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) return `err(${res.status})`;
    return "ok";
  } catch (e) {
    log.warn("alert.telegram_failed", { err: errStr(e) });
    return "err(throw)";
  }
}

// Derive a plausible sender from the site host. The domain must be verified in
// Resend for delivery to succeed (see the ops runbook); otherwise use Telegram.
function defaultFrom(env: Bindings): string {
  let host = "example.com";
  try {
    host = new URL(env.SITE_URL).hostname || host;
  } catch {
    // keep default
  }
  return `${env.SITE_NAME || "Edge Magazine"} Alerts <alerts@${host}>`;
}

// Post-run alerts (cron only): nothing produced, or too many failures.
export async function maybeAlertOnRun(
  env: Bindings,
  cfg: RuntimeConfig,
  report: RunReport,
): Promise<void> {
  const { requested } = report;
  if (requested <= 0) return;
  const failed = report.failed.length;
  const published = report.published.length;
  const held = report.held.length; // review mode: produced, just not auto-published

  if (published === 0 && held === 0) {
    await sendAlert(
      env,
      "empty-run",
      "Cron run produced no articles",
      `requested=${requested} failed=${failed} enqueued=${report.enqueued}\nrunId=${report.runId}\nfirst error: ${report.failed[0]?.error ?? "(none)"}`,
      `/admin/runs/${report.runId}`,
    );
    return;
  }
  const failRate = failed / requested;
  if (failRate > cfg.alerts.failRateThreshold) {
    await sendAlert(
      env,
      "high-fail-rate",
      "Cron run has a high failure rate",
      `failRate=${(failRate * 100).toFixed(0)}% (${failed}/${requested}) published=${published}\nrunId=${report.runId}`,
      `/admin/runs/${report.runId}`,
    );
  }
}

// Runs before each scheduled generation: unstick hung 'running' rows and alert
// if no run has succeeded within the staleness window. NOTE: this can only fire
// while the cron itself is still firing; a fully stopped cron must be caught by
// a Cloudflare dashboard notification (see the ops runbook).
export async function runWatchdog(env: Bindings, cfg: RuntimeConfig): Promise<void> {
  try {
    const hung = await hungRuns(env);
    for (const r of hung) await markRunFailed(env, r.id, "watchdog: hung > 2h");
    if (hung.length) {
      await sendAlert(
        env,
        "stale-run",
        "Hung pipeline run detected",
        `${hung.length} run(s) stuck in 'running' for over 2h; marked failed. ids=${hung
          .map((r) => r.id)
          .join(", ")}`,
      );
      return; // one stale-type alert per window
    }

    const good = await lastGoodRun(env);
    if (good) {
      const ageHours = (Date.now() - good.startedAt) / 3_600_000;
      if (ageHours > cfg.alerts.staleRunHours) {
        await sendAlert(
          env,
          "stale-run",
          "No recent successful run",
          `last good run was ${ageHours.toFixed(1)}h ago (id=${good.id}); threshold ${cfg.alerts.staleRunHours}h`,
        );
      }
    }
  } catch (e) {
    log.warn("watchdog.failed", { err: errStr(e) });
  }
}
