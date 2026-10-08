import { routes } from "../lib/config";
import { categoryColor, categoryPill } from "../lib/category";
import { uploadPath } from "../lib/images";
import { cleanText } from "../lib/sanitize";
import type { PostCard } from "../db/queries";
import type { BreadcrumbItem } from "../seo/structured-data";
import { Icon } from "./icons";

// "12400 -> 12.4k" (Figma shows abbreviated view counts).
export function formatViews(n: number): string {
  if (n < 1000) return String(n);
  const v = Math.round(n / 100) / 10;
  return `${v % 1 === 0 ? v.toFixed(0) : v}k`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// 24px initials circle standing in for an avatar photo (as in the Figma cards).
export function AuthorChip({ name, light }: { name: string; light?: boolean }) {
  return (
    <span class={light ? "avatar avatar--light" : "avatar"} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// Mono uppercase category label, colored per category (Figma design).
// pill = soft-tinted rounded chip used on photo overlays.
export function CategoryTag({
  name,
  size,
  pill,
}: {
  name: string;
  size?: "xs";
  pill?: boolean;
}) {
  if (pill) {
    const p = categoryPill(name);
    return (
      <span class="cat-pill" style={`background:${p.bg};color:${p.fg}`}>
        {name.toUpperCase()}
      </span>
    );
  }
  return (
    <span
      class={size === "xs" ? "cat-tag cat-tag--xs" : "cat-tag"}
      style={`color:${categoryColor(name)}`}
    >
      {name.toUpperCase()}
    </span>
  );
}

function Dot() {
  return <span class="meta-sep" aria-hidden="true" />;
}

// Section header: lucide icon + mono label + rule line + optional "See all".
export function SectionHead({
  icon,
  label,
  accent,
  line,
  seeAllHref,
}: {
  icon?: string;
  label: string;
  accent?: boolean;
  line?: boolean;
  seeAllHref?: string;
}) {
  return (
    <div class="sect-head">
      {icon ? (
        <Icon
          name={icon}
          size={13}
          class={accent ? "sect-head__icon is-accent" : "sect-head__icon"}
        />
      ) : null}
      <span class="sect-head__label">{label}</span>
      {line ? <span class="sect-head__line" aria-hidden="true" /> : null}
      {seeAllHref ? (
        <a class="sect-head__more" href={seeAllHref}>
          View all <Icon name="chevron-right" size={10} />
        </a>
      ) : null}
    </div>
  );
}

// Legacy eyebrow (accent square + mono label), still used by list pages.
export function Eyebrow({ label, line }: { label: string; line?: boolean }) {
  return (
    <div class="eyebrow">
      <span class="eyebrow__mark" aria-hidden="true" />
      <span class="eyebrow__text">{label}</span>
      {line ? <span class="eyebrow__line" aria-hidden="true" /> : null}
    </div>
  );
}

// Dark newsletter CTA card (sidebar / article). Submits to /newsletter (GET);
// the double opt-in POST flow lands in Phase 3.
export function NewsletterCard() {
  return (
    <div class="news-card">
      <div class="news-card__eyebrow">
        <Icon name="bell" size={12} class="is-accent" />
        <span>Newsletter</span>
      </div>
      <h3 class="news-card__title">Good habits, delivered weekly.</h3>
      <p class="news-card__text">
        Hand-picked ideas in your inbox every Monday morning. No spam,
        unsubscribe anytime.
      </p>
      <form class="news-card__form" action="/newsletter" method="get">
        <input
          type="email"
          name="email"
          placeholder="you@email.com"
          aria-label="Email address"
        />
        <button type="submit">Subscribe free</button>
      </form>
    </div>
  );
}

// Bare <img> for a photographic cover; object-fit handled by the media wrapper.
export function CoverImage({
  imageKey,
  alt,
  eager,
}: {
  imageKey: string | null;
  alt: string | null;
  eager?: boolean;
}) {
  const src = uploadPath(imageKey);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt ?? ""}
      width={1200}
      height={750}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

function ReadTime({
  minutes,
  iconSize = 10,
  suffix = " min read",
}: {
  minutes: number | null;
  iconSize?: number;
  suffix?: string;
}) {
  if (!minutes) return null;
  return (
    <span class="meta-time">
      <Icon name="clock" size={iconSize} />
      <span class="mono">
        {minutes}
        {suffix}
      </span>
    </span>
  );
}

function Views({
  count,
  iconSize = 10,
}: {
  count: number;
  iconSize?: number;
}) {
  if (!count) return null;
  return (
    <span class="meta-views">
      <Icon name="eye" size={iconSize} />
      <span class="mono">{formatViews(count)}</span>
    </span>
  );
}

// Standard article card (Latest grid, related, list pages).
export function PostCardView({ card }: { card: PostCard }) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="post-card">
      <a class="post-card__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <div class="post-card__body">
        <CategoryTag name={card.categoryName} />
        <h3 class="post-card__title">
          <a href={href}>{cleanText(card.title)}</a>
        </h3>
        {card.excerpt ? (
          <p class="post-card__excerpt">{cleanText(card.excerpt)}</p>
        ) : null}
        <div class="post-card__foot">
          <div class="post-card__meta">
            {card.authorName ? (
              <>
                <AuthorChip name={card.authorName} />
                <span class="post-card__author">{card.authorName}</span>
                <Dot />
              </>
            ) : null}
            <ReadTime minutes={card.readingTime} />
          </div>
          <div class="post-card__stats">
            <Views count={card.viewCount} />
            <span class="bookmark" aria-hidden="true">
              <Icon name="bookmark" size={12} />
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

// Large hero (lead featured story): photo, gradient, pill, meta w/ views+share.
export function HeroMain({ card }: { card: PostCard }) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="hero-main">
      <a class="hero-main__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} eager />
      </a>
      <span class="hero-main__pill">
        <CategoryTag name={card.categoryName} pill />
      </span>
      <div class="hero-main__body">
        <h2 class="hero-title">
          <a href={href}>{cleanText(card.title)}</a>
        </h2>
        {card.excerpt ? (
          <p class="hero-excerpt">{cleanText(card.excerpt)}</p>
        ) : null}
        <div class="hero-meta">
          {card.authorName ? (
            <>
              <AuthorChip name={card.authorName} light />
              <span>{card.authorName}</span>
              <Dot />
            </>
          ) : null}
          <ReadTime minutes={card.readingTime} />
          {card.viewCount ? (
            <>
              <Dot />
              <Views count={card.viewCount} />
            </>
          ) : null}
          <a class="hero-share" href={href} aria-label="Open article">
            <Icon name="share-2" size={12} />
          </a>
        </div>
      </div>
    </article>
  );
}

// Secondary featured card: full-bleed photo with gradient overlay (Figma).
export function HeroOverlayCard({ card }: { card: PostCard }) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="hero-sub">
      <a class="hero-sub__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <span class="hero-sub__pill">
        <CategoryTag name={card.categoryName} pill />
      </span>
      <div class="hero-sub__body">
        <h3 class="hero-sub__title">
          <a href={href}>{cleanText(card.title)}</a>
        </h3>
        <div class="hero-sub__meta">
          {card.authorName ? (
            <>
              <span>{card.authorName}</span>
              <Dot />
            </>
          ) : null}
          <ReadTime minutes={card.readingTime} iconSize={9} />
        </div>
      </div>
    </article>
  );
}

// Editor's picks strip card (small photo card, no excerpt).
export function PickCard({ card }: { card: PostCard }) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="pick-card">
      <a class="pick-card__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <div class="pick-card__body">
        <CategoryTag name={card.categoryName} />
        <h4 class="pick-card__title">
          <a href={href}>{cleanText(card.title)}</a>
        </h4>
        <div class="pick-card__meta">
          {card.authorName ? (
            <>
              <span>{card.authorName}</span>
              <Dot />
            </>
          ) : null}
          {card.readingTime ? (
            <span class="mono">{card.readingTime} min</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

// Numbered "Trending now" sidebar list (with read time + views).
export function TrendingList({ posts }: { posts: PostCard[] }) {
  return (
    <div class="trending">
      {posts.map((p, i) => {
        const href = routes.post(p.categorySlug, p.slug);
        return (
          <article class="trending__item">
            <span class="trending__num" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <CategoryTag name={p.categoryName} size="xs" />
              <h4 class="trending__title">
                <a href={href}>{cleanText(p.title)}</a>
              </h4>
              <div class="trending__meta">
                <ReadTime minutes={p.readingTime} iconSize={9} />
                {p.viewCount ? (
                  <>
                    <Dot />
                    <Views count={p.viewCount} iconSize={9} />
                  </>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// "Most saved" sidebar list: 56px thumbnail + title + read time.
export function MostSavedList({ posts }: { posts: PostCard[] }) {
  return (
    <div class="saved">
      {posts.map((p) => {
        const href = routes.post(p.categorySlug, p.slug);
        return (
          <article class="saved__item">
            <a class="saved__thumb" href={href} tabindex={-1} aria-hidden="true">
              <CoverImage imageKey={p.coverImageKey} alt={p.coverImageAlt} />
            </a>
            <div>
              <CategoryTag name={p.categoryName} size="xs" />
              <h4 class="saved__title">
                <a href={href}>{cleanText(p.title)}</a>
              </h4>
              <div class="saved__meta">
                <ReadTime minutes={p.readingTime} iconSize={9} />
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// Server-side <mark> highlighter for search results.
export function highlightText(text: string, q?: string) {
  const clean = cleanText(text);
  if (!q) return clean;
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = clean.split(new RegExp(`(${safe})`, "gi"));
  return parts.map((p) =>
    p.toLowerCase() === q.toLowerCase() ? <mark>{p}</mark> : p,
  );
}

// Compact grid card (category/tag/author/search grids; smaller type than the
// home grid card). highlight marks search-term matches in the title.
export function CatCard({
  card,
  highlight,
}: {
  card: PostCard;
  highlight?: string;
}) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="cat-card">
      <a class="cat-card__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <div class="cat-card__body">
        <CategoryTag name={card.categoryName} />
        <h3 class="cat-card__title">
          <a href={href}>{highlightText(card.title, highlight)}</a>
        </h3>
        {card.excerpt ? (
          <p class="cat-card__excerpt">{cleanText(card.excerpt)}</p>
        ) : null}
        <div class="cat-card__foot">
          <div class="cat-card__meta">
            {card.authorName ? (
              <>
                <AuthorChip name={card.authorName} />
                <span>{card.authorName}</span>
                <span class="meta-sep" aria-hidden="true" />
              </>
            ) : null}
            {card.readingTime ? (
              <span class="meta-time">
                <Icon name="clock" size={10} />
                <span class="mono">{card.readingTime} min read</span>
              </span>
            ) : null}
          </div>
          <span class="bookmark" aria-hidden="true">
            <Icon name="bookmark" size={11} />
          </span>
        </div>
      </div>
    </article>
  );
}

// Horizontal row for list layouts (category/tag/search list view).
export function PostRow({
  card,
  highlight,
}: {
  card: PostCard;
  highlight?: string;
}) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="post-row">
      <a class="post-row__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <div class="post-row__body">
        <div>
          <CategoryTag name={card.categoryName} />
          <h3 class="post-row__title">
            <a href={href}>{highlightText(card.title, highlight)}</a>
          </h3>
          {card.excerpt ? (
            <p class="post-row__excerpt">
              {highlightText(card.excerpt, highlight)}
            </p>
          ) : null}
        </div>
        <div class="post-row__foot">
          <div class="post-row__meta">
            {card.authorName && card.authorSlug ? (
              <>
                <a class="post-row__author" href={routes.author(card.authorSlug)}>
                  {card.authorName}
                </a>
                <span class="meta-sep" aria-hidden="true" />
              </>
            ) : null}
            {card.readingTime ? (
              <span class="meta-time">
                <Icon name="clock" size={10} />
                <span class="mono">{card.readingTime} min read</span>
              </span>
            ) : null}
            {card.viewCount ? (
              <span class="meta-views post-row__views">
                <Icon name="eye" size={10} />
                <span class="mono">{formatViews(card.viewCount)}</span>
              </span>
            ) : null}
          </div>
          <span class="bookmark" aria-hidden="true">
            <Icon name="bookmark" size={12} />
          </span>
        </div>
      </div>
    </article>
  );
}

// Shared right sidebar on search/tag/author pages: trending, tags, newsletter.
export function SharedSidebar({
  trending,
  tags,
}: {
  trending: PostCard[];
  tags: { slug: string; name: string }[];
}) {
  return (
    <div class="shared-side">
      <div>
        <SectionHead icon="trending-up" accent label="Trending" />
        <TrendingList posts={trending} />
      </div>
      <div class="sidebar__divider" />
      <div>
        <div class="side-head">
          <Icon name="hash" size={11} />
          <span>Popular tags</span>
        </div>
        <div class="topics">
          {tags.map((t) => (
            <a class="topic-btn" href={routes.tag(t.slug)}>
              {t.name}
            </a>
          ))}
        </div>
      </div>
      <div class="sidebar__divider" />
      <NewsletterCard />
    </div>
  );
}

// "Load more ->" (SSR: a link to the next cumulative page of the grid).
export function LoadMoreLink({ href }: { href: string }) {
  return (
    <div class="btn-row">
      <a class="btn-outline" href={href}>
        See more <Icon name="arrow-right" size={12} />
      </a>
    </div>
  );
}

export function PostGrid({ posts }: { posts: PostCard[] }) {
  if (posts.length === 0) return <p class="empty">No articles yet.</p>;
  return (
    <div class="post-grid">
      {posts.map((p) => (
        <PostCardView card={p} />
      ))}
    </div>
  );
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {items.map((it, i) => (
          <li>
            {i < items.length - 1 ? (
              <a href={it.url}>{it.name}</a>
            ) : (
              <span aria-current="page">{it.name}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Pagination({
  basePath,
  page,
  total,
  perPage,
  query,
}: {
  basePath: string;
  page: number;
  total: number;
  perPage: number;
  query?: Record<string, string>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;

  const build = (p: number) => {
    const params = new URLSearchParams(query);
    if (p > 1) params.set("page", String(p));
    else params.delete("page");
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <nav class="pagination" aria-label="Pagination">
      {page > 1 ? (
        <a href={build(page - 1)} rel="prev">
          Previous
        </a>
      ) : null}
      <span class="pagination__status">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <a href={build(page + 1)} rel="next">
          Next
        </a>
      ) : null}
    </nav>
  );
}
