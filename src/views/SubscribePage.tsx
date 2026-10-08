import { routes } from "../lib/config";
import { Icon } from "./icons";

// Static marketing copy from the Figma subscribe page (clean ASCII).
const BENEFITS = [
  {
    icon: "mail",
    title: "Weekly curated newsletter",
    desc: "The 5 best articles of the week, hand-picked by our editors every Monday morning.",
  },
  {
    icon: "zap",
    title: "Early access to new articles",
    desc: "Subscribers get to read new articles 24 hours before the public.",
  },
  {
    icon: "filter",
    title: "Topic filters",
    desc: "Tell us what you care about and only receive content on the topics you choose.",
  },
  {
    icon: "bar-chart-2",
    title: "Stats and reading streaks",
    desc: "Track how consistently you read and watch your knowledge build over time.",
  },
  {
    icon: "bookmark",
    title: "Saved and reading lists",
    desc: "Save articles to your own reading list and pick up where you left off.",
  },
  {
    icon: "shield",
    title: "No ads, ever",
    desc: "No ads, no pop-ups, no paywall. Just the content and you.",
  },
];

// Trust pass 2026-07-10: the old invented reader testimonials (fake names +
// 5-star cards) were fabricated social proof and are gone for good. FAQ copy
// below states only what the site actually does today (weekly
// newsletter signup stored in D1).
const FAQS = [
  {
    q: "Is it really free?",
    a: "Yes. Reading every article and getting the weekly newsletter is completely free, with no limits. There is no paid plan.",
  },
  {
    q: "How often will I get email?",
    a: "Weekly: one digest of the best articles. No other emails.",
  },
  {
    q: "Can I unsubscribe anytime?",
    a: "Absolutely. Every email has a one-click unsubscribe link at the bottom. No tricks, no re-confirmation loops.",
  },
  {
    q: "Why choose topics when subscribing?",
    a: "The newsletter is currently one shared digest. The topics you tick are saved as preferences, so when topic-specific newsletters launch you get exactly what you care about.",
  },
  {
    q: "Do you sell my email address?",
    a: "Never. We have no ad network and no data-broker partners. Your email is only used to send you our content.",
  },
];

export function SubscribePageView({
  submitted,
  name,
  email = "",
  error,
  turnstileSiteKey,
  categories,
}: {
  submitted: boolean;
  name: string;
  email?: string;
  error?: string;
  turnstileSiteKey?: string;
  categories: { slug: string; name: string }[];
}) {
  return (
    <>
      {/* ── Hero ── */}
      <div class="sub-hero">
        <div class="sub-hero__inner">
          <div class="sub-hero__pill">
            <Icon name="sparkles" size={11} />
            <span>Weekly newsletter, free for everyone</span>
          </div>
          <h1 class="sub-hero__title">
            Good habits, delivered.
            <br />
            Results that compound.
          </h1>
          <p class="sub-hero__desc">
            Every Monday, our best work lands in your inbox: evidence-based
            articles on productivity, health and habits. Real quality, and
            completely free.
          </p>
          <div class="sub-hero__checks">
            {["Free forever", "No spam", "Unsubscribe anytime"].map((t) => (
              <span class="sub-hero__check">
                <Icon name="circle-check" size={12} /> {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div class="sub-container" id="subscribe">
        <div class="sub-signup">
          {/* ── Signup form ── */}
          <div class="sub-form-col">
            <h2 class="sub-h2">Subscribe to the free newsletter</h2>
            <p class="sub-sub">
              Takes 30 seconds, free forever. No credit card required.
            </p>

            {submitted ? (
              <div class="sub-done">
                <Icon name="circle-check" size={40} class="sub-done__icon" />
                <h3 class="sub-done__title">All set, {name || "friend"}!</h3>
                <p class="sub-done__text">
                  Check your inbox: your first issue arrives this Monday.
                  Welcome aboard.
                </p>
                <a class="sub-done__btn" href={routes.home()}>
                  Explore articles <Icon name="arrow-right" size={13} />
                </a>
              </div>
            ) : (
              <form class="sub-form" action={routes.newsletter()} method="post">
                {error ? (
                  <p class="sub-legal mono" role="alert" style="color:#d9291b">
                    {error}
                  </p>
                ) : null}
                <div class="sub-field">
                  <label class="sub-label mono" for="sub-name">
                    Your name
                  </label>
                  <input
                    id="sub-name"
                    type="text"
                    name="name"
                    placeholder="Name"
                    value={name}
                  />
                </div>
                <div class="sub-field">
                  <label class="sub-label mono" for="sub-email">
                    Email address
                  </label>
                  <input
                    id="sub-email"
                    type="email"
                    name="email"
                    required
                    placeholder="ban@email.com"
                    value={email}
                  />
                </div>

                <div class="sub-field">
                  <span class="sub-label mono">Newsletter frequency</span>
                  <div class="freq-row">
                    <label class="freq-opt">
                      <input type="radio" name="frequency" value="weekly" checked />
                      <span class="freq-opt__body">
                        <span class="freq-opt__name">Weekly (Monday)</span>
                        <span class="freq-opt__desc mono">Best of the week</span>
                      </span>
                    </label>
                    <label class="freq-opt">
                      <input type="radio" name="frequency" value="daily" />
                      <span class="freq-opt__body">
                        <span class="freq-opt__name">Daily</span>
                        <span class="freq-opt__desc mono">Fresh every morning</span>
                      </span>
                    </label>
                  </div>
                </div>

                <div class="sub-field">
                  <span class="sub-label mono">Topics (optional)</span>
                  <div class="topic-choices">
                    {categories.map((cat) => (
                      <label class="topic-choice">
                        <input
                          type="checkbox"
                          name="topics"
                          value={cat.slug}
                          checked
                        />
                        <span>
                          <Icon name="check" size={10} /> {cat.name}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Turnstile anti-bot (the one allowed external script; only
                    on this page, only when configured). */}
                {turnstileSiteKey ? (
                  <>
                    <div class="cf-turnstile" data-sitekey={turnstileSiteKey} />
                    <script
                      src="https://challenges.cloudflare.com/turnstile/v0/api.js"
                      async
                      defer
                    />
                  </>
                ) : null}

                <button class="sub-submit mono" type="submit">
                  Subscribe free {"->"}
                </button>
                <p class="sub-legal mono">
                  By subscribing, you agree to our{" "}
                  <a href="/privacy">Privacy Policy</a>. Unsubscribe anytime.
                </p>
              </form>
            )}
          </div>
        </div>

        {/* ── Benefits ── */}
        <div class="sub-sect">
          <div class="sub-sect__head">
            <h2 class="sub-sect__title">What you get when you subscribe</h2>
            <p class="sub-sect__sub">
              Everything is built around one goal: helping you form better habits, consistently.
            </p>
          </div>
          <div class="benefits-grid">
            {BENEFITS.map((b) => (
              <div class="benefit">
                <span class="benefit__icon">
                  <Icon name={b.icon} size={16} />
                </span>
                <h3 class="benefit__title">{b.title}</h3>
                <p class="benefit__desc">{b.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── FAQ (native details accordion) ── */}
        <div class="sub-faq">
          <h2 class="sub-sect__title sub-faq__title">
            Frequently asked questions
          </h2>
          <div class="faq-list">
            {FAQS.map((f) => (
              <details class="faq">
                <summary>
                  <span>{f.q}</span>
                  <Icon name="chevron-down" size={14} />
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>

        {/* ── Final CTA ── */}
        <div class="sub-cta">
          <h2 class="sub-cta__title">Ready to start compounding?</h2>
          <p class="sub-cta__text">
            Build better habits, one article at a time.
          </p>
          <a class="sub-cta__btn mono" href="#subscribe">
            Subscribe free <Icon name="arrow-right" size={14} />
          </a>
        </div>
      </div>
    </>
  );
}
