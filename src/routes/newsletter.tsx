import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import { getNavCategories } from "../db/queries";
import { siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { SubscribePageView } from "../views/SubscribePage";
import { cleanText } from "../lib/sanitize";
import { clientIp, rateLimit } from "../lib/ratelimit";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile";
import { log, errStr } from "../lib/log";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Subscribe page (Figma design). GET renders the form (prefilling any name/email
// carried from an inline CTA card); the real subscribe is POST (B6) - rate
// limited, Turnstile-verified, writing a pending subscriber. The double opt-in
// confirmation email (tech-spec 11.2) is still Phase 3; a subscriber lands
// 'pending' with a token ready for that flow.
export async function newsletterRoute(c: Context<AppEnv>) {
  return withEdgeCache(c, TTL.navStatic, async () => {
    const email = (c.req.query("email") ?? "").trim();
    const name = (c.req.query("name") ?? "").trim().slice(0, 40);
    // ?ok=1 is the post-subscribe success landing (PRG); a prefilled email is
    // NOT success - a crawled GET link must never subscribe.
    const submitted = c.req.query("ok") === "1";
    return renderSubscribe(c, { submitted, name, email });
  });
}

export async function newsletterSubscribe(c: Context<AppEnv>) {
  const ip = clientIp(c.req.raw);
  const form = await c.req.formData();
  const email = (form.get("email")?.toString() ?? "").trim().toLowerCase();
  const name = cleanText(form.get("name")?.toString() ?? "").slice(0, 40);

  const fail = (error: string, status = 400) =>
    renderSubscribe(c, { submitted: false, name, email, error }, status);

  // Rate limit: 5 attempts / hour / IP.
  const rl = await rateLimit(c.env, "newsletter", ip, 5, 3600);
  if (!rl.allowed) {
    return fail("Too many attempts. Please try again in a few minutes.", 429);
  }

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return fail("Invalid email address.");
  }

  // Turnstile (skipped when unconfigured, e.g. local dev).
  const token = form.get("cf-turnstile-response")?.toString();
  if (!(await verifyTurnstile(c.env, token, ip))) {
    return fail("Bot verification failed. Please try again.");
  }

  // Idempotent insert: a repeat email is a no-op success (never reveal whether
  // an address is already subscribed).
  try {
    await c.env.DB.prepare(
      `INSERT INTO subscribers (email, status, token, source)
       VALUES (?, 'pending', ?, 'newsletter')
       ON CONFLICT(email) DO NOTHING`,
    )
      .bind(email, crypto.randomUUID())
      .run();
    log.info("newsletter.subscribe", { emailDomain: email.split("@")[1] ?? "" });
  } catch (e) {
    log.error("newsletter.subscribe_failed", { err: errStr(e) });
    return fail("Something went wrong. Please try again later.", 500);
  }

  return renderSubscribe(c, { submitted: true, name, email }, 200);
}

// Shared render for both handlers (GET cache wrapper / POST direct).
async function renderSubscribe(
  c: Context<AppEnv>,
  state: { submitted: boolean; name: string; email: string; error?: string },
  status = 200,
) {
  const site = siteConfig(c.env, new URL(c.req.url).origin);
  const nav = await getNavCategories(db(c.env.DB));
  const meta = {
    title: pageTitle(site, "Newsletter"),
    description:
      "Hand-picked ideas in your inbox every Monday. No spam, unsubscribe anytime.",
    canonical: `${site.url}/newsletter`,
    ogType: "website" as const,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: site.url },
          {
            "@type": "ListItem",
            position: 2,
            name: "Newsletter",
            item: `${site.url}/newsletter`,
          },
        ],
      },
    ],
  };

  const body = (
    <SubscribePageView
      submitted={state.submitted}
      name={state.name}
      email={state.email}
      error={state.error}
      turnstileSiteKey={turnstileEnabled(c.env) ? c.env.TURNSTILE_SITE_KEY : undefined}
      categories={nav}
    />
  );

  return renderPage(c, { site, meta, nav, body, bare: true, status });
}
