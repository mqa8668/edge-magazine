import { routes } from "../lib/config";
import { uploadPath } from "../lib/images";
import { cleanText } from "../lib/sanitize";
import type { Author } from "../db/schema";
import { Icon } from "./icons";
import { SectionHead } from "./components";

// Redesigned "About" page: dark hero + founding story, stats bar,
// mission + 4 core values, editorial team (-> author pages), 3 purpose-based
// contact cards, newsletter CTA. Full-bleed: rendered with `bare` so it manages
// its own containers. Copy is plain English.

interface Stat {
  value: string;
  label: string;
  icon?: string;
}

// Real numbers only (trust pass 2026-07-10: the old hardcoded subscriber/view/
// rating figures were fabricated social proof). Built from live counts passed
// in by the route.
function buildStats(postCount: number, categoryCount: number, authorCount: number): Stat[] {
  return [
    { value: String(postCount), label: "Articles", icon: "book-open" },
    { value: String(categoryCount), label: "Categories", icon: "layout-grid" },
    { value: String(authorCount), label: "Editorial desks", icon: "users" },
  ];
}

const VALUES: { icon: string; title: string; body: string }[] = [
  {
    icon: "book-open",
    title: "Evidence-based",
    body: "Every piece of advice rests on research and data, not hunches or hearsay.",
  },
  {
    icon: "zap",
    title: "Practical and actionable",
    body: "We favor steps you can apply today over abstract theory.",
  },
  {
    icon: "shield",
    title: "No hidden ads",
    body: "We do not sell disguised PR. Sponsored content, if any, is always labeled.",
  },
  {
    icon: "sparkles",
    title: "Transparent about AI",
    body: "Articles are drafted with AI assistance under editorial standards, and we say so openly.",
  },
];

function buildContacts(email: string): {
  icon: string;
  title: string;
  body: string;
  email: string;
  href: string;
  cta: string;
}[] {
  const cards = [
    {
      icon: "users",
      title: "Write for us",
      body: "Have a useful perspective on living and working better?",
      email,
      href: "/write-for-us",
      cta: "Pitch us",
    },
    {
      icon: "mail",
      title: "Press and partnerships",
      body: "Partnership offers, interviews or media requests go straight to the team.",
      email,
      href: `mailto:${email}`,
      cta: "Send an email",
    },
    {
      icon: "message-circle",
      title: "Support and feedback",
      body: "Questions, feedback or a mistake spotted in an article - we read everything.",
      email,
      href: "/contact",
      cta: "Contact page",
    },
  ];
  // No contact email configured: hide the mailto card.
  return email ? cards : cards.filter((c) => !c.href.startsWith("mailto:"));
}

function TeamCard({ author }: { author: Author }) {
  const avatar = author.avatarKey ? uploadPath(author.avatarKey) : null;
  return (
    <a class="team-card" href={routes.author(author.slug)}>
      {avatar ? (
        <img
          class="team-card__avatar"
          src={avatar}
          alt={author.name}
          width={72}
          height={72}
          loading="lazy"
        />
      ) : (
        <span class="team-card__avatar team-card__avatar--fallback" aria-hidden="true">
          <Icon name="user" size={26} />
        </span>
      )}
      <h3 class="team-card__name">{author.name}</h3>
      {author.role ? (
        <span class="team-card__role mono">{cleanText(author.role)}</span>
      ) : null}
      {author.shortBio ? (
        <p class="team-card__bio">{cleanText(author.shortBio)}</p>
      ) : null}
      <span class="team-card__link mono">
        View articles <Icon name="arrow-right" size={11} />
      </span>
    </a>
  );
}

export function AboutPageView({
  site,
  contactEmail = "",
  authors,
  postCount,
  categoryCount,
}: {
  site: { name: string };
  contactEmail?: string;
  authors: Author[];
  postCount: number;
  categoryCount: number;
}) {
  const stats = buildStats(postCount, categoryCount, authors.length);
  return (
    <>
      {/* Hero */}
      <section class="about-hero">
        <div class="container about-hero__inner">
          <nav class="about-hero__crumb" aria-label="Breadcrumb">
            <a href={routes.home()}>Home</a>
            <Icon name="chevron-right" size={9} />
            <span>About</span>
          </nav>
          <p class="about-hero__eyebrow">ABOUT</p>
          <h1 class="about-hero__title">
            Small changes, repeated long enough, make a big difference.
          </h1>
          <p class="about-hero__lead">
            {site.name} began with a simple question: why does so much self-improvement
            advice sound great yet so few people actually follow it? We rewrite
            that knowledge as small, real steps anyone can try right away - and
            keep it free for everyone.
          </p>
        </div>
      </section>

      {/* Stats */}
      <section class="about-stats">
        <div class="container about-stats__grid">
          {stats.map((s) => (
            <div class="about-stat">
              <div class="about-stat__value">
                {s.icon ? (
                  <Icon name={s.icon} size={16} class="about-stat__icon" />
                ) : null}
                <b>{s.value}</b>
              </div>
              <span class="about-stat__label mono">{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Mission + values */}
      <section class="container about-section">
        <div class="about-mission">
          <SectionHead label="Mission" line />
          <p class="about-mission__text">
            Turn research in behavior, psychology and health science into things
            you can start doing today - no confusing jargon, no miracle
            promises, and free for everyone.
          </p>
        </div>
        <div class="about-values">
          {VALUES.map((v) => (
            <div class="value-card">
              <span class="value-card__icon" aria-hidden="true">
                <Icon name={v.icon} size={18} />
              </span>
              <h3 class="value-card__title">{v.title}</h3>
              <p class="value-card__body">{v.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Team */}
      {authors.length > 0 ? (
        <section class="container about-section">
          <SectionHead label="Editorial team" line />
          <div class="about-team">
            {authors.slice(0, 4).map((a) => (
              <TeamCard author={a} />
            ))}
          </div>
          <p class="about-team__note">
            Author names are editorial desks of {site.name}, each with its own
            voice - they do not represent real individuals. Learn more in our{" "}
            <a href="/editorial-standards">Editorial standards</a>.
          </p>
        </section>
      ) : null}

      {/* Contact */}
      <section class="container about-section">
        <SectionHead label="Contact" line />
        <div class="about-contact">
          {buildContacts(contactEmail).map((ct) => (
            <a class="contact-card" href={ct.href}>
              <span class="contact-card__icon" aria-hidden="true">
                <Icon name={ct.icon} size={18} />
              </span>
              <h3 class="contact-card__title">{ct.title}</h3>
              <p class="contact-card__body">{ct.body}</p>
              {ct.email ? <span class="contact-card__email mono">{ct.email}</span> : null}
              <span class="contact-card__cta mono">
                {ct.cta} <Icon name="arrow-right" size={11} />
              </span>
            </a>
          ))}
        </div>
      </section>

      {/* Newsletter CTA */}
      <section class="about-cta">
        <div class="container about-cta__inner">
          <div class="about-cta__body">
            <p class="about-cta__eyebrow mono">FREE NEWSLETTER</p>
            <h2 class="about-cta__title">
              Get one dose of good habits every week.
            </h2>
            <p class="about-cta__text">
              Curated insights from {site.name}, delivered every Monday morning.
              No spam, unsubscribe anytime.
            </p>
          </div>
          <form class="about-cta__form" action="/newsletter" method="get">
            <input
              type="email"
              name="email"
              placeholder="you@example.com"
              aria-label="Email address"
            />
            <button type="submit">Subscribe free</button>
          </form>
        </div>
      </section>
    </>
  );
}
