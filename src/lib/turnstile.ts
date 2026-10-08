// Cloudflare Turnstile server-side verification for the newsletter form (B6).
// The widget (public site key) renders on /newsletter and posts a token; we
// verify it here against the secret. When TURNSTILE_SECRET_KEY is unset (e.g.
// local dev) verification is skipped so the form still works.

import type { Bindings } from "../env";
import { log, errStr } from "./log";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Returns true when the challenge passes OR when Turnstile is not configured.
export async function verifyTurnstile(
  env: Bindings,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured -> do not block (dev/first deploy)
  if (!token) return false;

  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body: form });
    if (!res.ok) {
      log.warn("turnstile.http_error", { status: res.status });
      return false;
    }
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    log.warn("turnstile.verify_failed", { err: errStr(e) });
    return false; // fail closed: a broken verifier must not let bots through
  }
}

// Whether the widget should render (public site key present).
export function turnstileEnabled(env: Bindings): boolean {
  return !!env.TURNSTILE_SITE_KEY;
}
