import { raw } from "hono/html";
import { routes } from "../lib/config";
import { formatDisplay } from "../lib/dates";
import { uploadPath } from "../lib/images";
import { cleanHtml, cleanText } from "../lib/sanitize";
import type { Author, Category, Post } from "../db/schema";
import type { PostCard } from "../db/queries";
import {
  CategoryTag,
  CoverImage,
  SectionHead,
  formatViews,
} from "./components";
import { Icon } from "./icons";

interface Tag {
  id: number;
  slug: string;
  name: string;
}

// Categories that touch health/medical topics and need an on-page "not medical
// advice" disclaimer (VN health-info rules + Google content-policy hygiene).
const HEALTH_CATEGORIES = new Set([
  "wellness",
  "sleep",
  "mindfulness",
  "exercise",
  "nutrition",
]);

function slugifyHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Inject ids into <h2>s and collect them for the "In this article" ToC.
function buildToc(bodyHtml: string): {
  html: string;
  toc: { id: string; title: string }[];
} {
  const toc: { id: string; title: string }[] = [];
  const html = bodyHtml.replace(/<h2>(.*?)<\/h2>/g, (_m, inner: string) => {
    const title = inner.replace(/<[^>]+>/g, "");
    let id = slugifyHeading(title) || `section-${toc.length + 1}`;
    if (toc.some((t) => t.id === id)) id = `${id}-${toc.length + 1}`;
    toc.push({ id, title });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  return { html, toc };
}

// Compact related-article card ("You might also like" band).
function RelatedCard({ card }: { card: PostCard }) {
  const href = routes.post(card.categorySlug, card.slug);
  return (
    <article class="rel-card">
      <a class="rel-card__media" href={href} tabindex={-1} aria-hidden="true">
        <CoverImage imageKey={card.coverImageKey} alt={card.coverImageAlt} />
      </a>
      <div class="rel-card__body">
        <CategoryTag name={card.categoryName} />
        <h3 class="rel-card__title">
          <a href={href}>{cleanText(card.title)}</a>
        </h3>
        {card.excerpt ? (
          <p class="rel-card__excerpt">{cleanText(card.excerpt)}</p>
        ) : null}
        <div class="rel-card__meta">
          {card.authorName ? (
            <>
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
          {card.viewCount ? (
            <span class="meta-views rel-card__views">
              <Icon name="eye" size={10} />
              <span class="mono">{formatViews(card.viewCount)}</span>
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ArticleView({
  post,
  category,
  author,
  tags,
  related,
  trending,
  cluster,
  nextInCluster,
  canonical,
}: {
  post: Post;
  category: Category;
  author: Author | null;
  tags: Tag[];
  related: PostCard[];
  trending: PostCard[];
  cluster?: { slug: string; name: string } | null;
  nextInCluster?: PostCard | null;
  canonical: string;
}) {
  const cover = uploadPath(post.coverImageKey);
  const avatar = author?.avatarKey ? uploadPath(author.avatarKey) : null;
  const { html: bodyHtml, toc } = buildToc(cleanHtml(post.processedHtml));

  const twitterShare = `https://twitter.com/intent/tweet?url=${encodeURIComponent(canonical)}&text=${encodeURIComponent(post.title)}`;
  const mailShare = `mailto:?subject=${encodeURIComponent(post.title)}&body=${encodeURIComponent(canonical)}`;

  const tocBlock = (
    <nav class="toc__list" aria-label="On this page">
      {toc.map((s) => (
        <a class="toc__link" href={`#${s.id}`}>
          {s.title}
        </a>
      ))}
    </nav>
  );

  return (
    <>
      {/* Reading progress bar under the sticky header (CSS scroll-driven). */}
      <div class="read-progress" aria-hidden="true" />

      {/* ── Hero ── */}
      <div class="detail-hero">
        {cover ? (
          <img
            class="detail-hero__img"
            src={cover}
            alt={post.coverImageAlt ?? ""}
            width={1400}
            height={750}
            loading="eager"
            decoding="async"
          />
        ) : null}
        <div class="detail-hero__scrim" aria-hidden="true" />
        <div class="detail-hero__inner">
          <div class="detail-hero__body">
            <nav class="detail-crumb" aria-label="Breadcrumb">
              <a href={routes.home()}>Home</a>
              <Icon name="chevron-right" size={10} />
              <a
                class="detail-crumb__cat"
                href={routes.category(category.slug)}
              >
                {category.name.toUpperCase()}
              </a>
            </nav>
            <CategoryTag name={category.name} pill />
            <h1 class="detail-title">{cleanText(post.title)}</h1>
            {post.excerpt ? (
              <p class="detail-excerpt">{cleanText(post.excerpt)}</p>
            ) : null}
            <div class="detail-meta">
              {author ? (
                <>
                  {avatar ? (
                    <img
                      class="detail-meta__avatar"
                      src={avatar}
                      alt={author.name}
                      width={32}
                      height={32}
                    />
                  ) : null}
                  <span class="detail-meta__who">
                    <a class="detail-meta__name" href={routes.author(author.slug)}>
                      {author.name}
                    </a>
                  </span>
                  <span class="detail-meta__bar" aria-hidden="true" />
                </>
              ) : null}
              {post.readingTime ? (
                <span class="meta-time">
                  <Icon name="clock" size={11} />
                  <span class="mono">{post.readingTime} min read</span>
                </span>
              ) : null}
              {post.viewCount ? (
                <span class="meta-views">
                  <Icon name="eye" size={11} />
                  <span class="mono">{formatViews(post.viewCount)} views</span>
                </span>
              ) : null}
              <time class="detail-meta__date mono" datetime={post.publishedAt}>
                {formatDisplay(post.publishedAt)}
              </time>
            </div>
          </div>
        </div>
      </div>

      {/* ── Action bar (share actions) ── */}
      <div class="action-bar">
        <div class="action-bar__inner">
          <div class="action-bar__group">
            <a class="action-btn" href={mailShare}>
              <Icon name="link-2" size={13} /> Share via email
            </a>
          </div>
          <div class="action-bar__group">
            <a
              class="action-btn action-btn--icon"
              href={twitterShare}
              target="_blank"
              rel="noopener nofollow"
              aria-label="Share on X"
            >
              <Icon name="twitter" size={13} />
            </a>
          </div>
        </div>
      </div>

      {/* ── Main 3-column grid ── */}
      <div class="container detail-grid">
        {/* Left: table of contents + tags */}
        <aside class="detail-toc">
          <div class="detail-toc__sticky">
            {toc.length > 0 ? (
              <div>
                <div class="side-head">
                  <Icon name="list" size={12} />
                  <span>On this page</span>
                </div>
                {tocBlock}
              </div>
            ) : null}
            {tags.length > 0 ? (
              <div class="toc__tags">
                <div class="side-head">
                  <Icon name="tag" size={11} />
                  <span>Tags</span>
                </div>
                <div class="tag-chips">
                  {tags.map((t) => (
                    <a class="tag-chip" href={routes.tag(t.slug)}>
                      {t.name}
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </aside>

        {/* Center: article body */}
        <article class="detail-body">
          {cluster ? (
            <a class="detail-cluster" href={routes.cluster(cluster.slug)}>
              <Icon name="layout-grid" size={12} />
              <span class="detail-cluster__label">Topic:</span>
              <strong>{cluster.name}</strong>
            </a>
          ) : null}
          {toc.length > 0 ? (
            <details class="toc-mobile">
              <summary>
                <Icon name="list" size={12} /> On this page
              </summary>
              <div class="toc-mobile__list">{tocBlock}</div>
            </details>
          ) : null}

          {/* Pre-rendered HTML from the pipeline (ids injected for the ToC). */}
          <div
            class="article__body"
            dangerouslySetInnerHTML={{
              __html: raw(bodyHtml) as unknown as string,
            }}
          />

          {/* Health topics: on-page "not medical advice" disclaimer. */}
          {HEALTH_CATEGORIES.has(category.slug) ? (
            <aside class="health-disclaimer" role="note">
              <strong>Health note.</strong> This article is for general information
              only and does not replace professional medical advice, diagnosis
              or treatment. Consult a doctor or qualified specialist before
              changing your diet, exercise, sleep or medication.
            </aside>
          ) : null}

          {tags.length > 0 ? (
            <div class="detail-tags-mobile tag-chips">
              {tags.map((t) => (
                <a class="tag-chip" href={routes.tag(t.slug)}>
                  {t.name}
                </a>
              ))}
            </div>
          ) : null}

          {/* Share row */}
          <div class="share-row">
            <span class="share-row__label">Share this article</span>
            <div class="share-row__btns">
              <a
                class="share-btn"
                href={twitterShare}
                target="_blank"
                rel="noopener nofollow"
              >
                <Icon name="twitter" size={12} /> X
              </a>
              <a class="share-btn" href={mailShare}>
                <Icon name="link-2" size={12} /> Share via email
              </a>
            </div>
          </div>

          {/* Author card */}
          {author ? (
            <div class="author-card">
              {avatar ? (
                <img
                  class="author-card__avatar"
                  src={avatar}
                  alt={author.name}
                  width={56}
                  height={56}
                />
              ) : null}
              <div class="author-card__main">
                <div class="author-card__top">
                  <div>
                    <div class="side-head">
                      <Icon name="user" size={11} />
                      <span>Author</span>
                    </div>
                    <h3 class="author-card__name">
                      <a href={routes.author(author.slug)}>{author.name}</a>
                    </h3>
                  </div>
                  <a class="follow-btn" href={routes.author(author.slug)}>
                    <Icon name="bell" size={11} /> Follow
                  </a>
                </div>
                {author.bio ? (
                  <p class="author-card__bio">{cleanText(author.bio)}</p>
                ) : null}
                <div class="author-card__stats mono">
                  <span>{author.postCount} {author.postCount === 1 ? "article" : "articles"}</span>
                </div>
              </div>
            </div>
          ) : null}

          {/* Next spoke in the same topic cluster (D2 retention) */}
          {cluster && nextInCluster ? (
            <div class="next-read">
              <div class="side-head">
                <Icon name="layout-grid" size={12} class="is-accent" />
                <span>Next in topic</span>
              </div>
              <a
                class="next-read__card"
                href={routes.post(nextInCluster.categorySlug, nextInCluster.slug)}
              >
                <span class="next-read__media" aria-hidden="true">
                  <CoverImage
                    imageKey={nextInCluster.coverImageKey}
                    alt={nextInCluster.coverImageAlt}
                  />
                </span>
                <span class="next-read__body">
                  <span class="next-read__cluster mono">{cluster.name}</span>
                  <strong class="next-read__title">
                    {cleanText(nextInCluster.title)}
                  </strong>
                  {nextInCluster.readingTime ? (
                    <span class="next-read__meta">
                      <Icon name="clock" size={10} />
                      <span class="mono">
                        {nextInCluster.readingTime} min read
                      </span>
                    </span>
                  ) : null}
                </span>
                <Icon name="arrow-right" size={14} class="next-read__arrow" />
              </a>
            </div>
          ) : null}

        </article>

        {/* Right sidebar */}
        <aside class="detail-side">
          <div class="detail-side__sticky">
            {/* Reading progress (bar is CSS scroll-driven) */}
            <div class="progress-card">
              <div class="progress-card__head">
                <span class="side-head__label">Reading progress</span>
              </div>
              <div class="progress-card__track" aria-hidden="true">
                <div class="progress-card__fill" />
              </div>
              {post.readingTime ? (
                <div class="progress-card__time">
                  <Icon name="clock" size={10} />
                  <span class="mono">{post.readingTime} min read</span>
                </div>
              ) : null}
            </div>

            {/* Compact newsletter signup */}
            <div class="news-card news-card--mini">
              <Icon name="bell" size={13} class="is-accent" />
              <h3 class="news-card__title">Hand-picked articles, straight to your inbox.</h3>
              <p class="news-card__text">Weekly newsletter. No spam. Unsubscribe anytime.</p>
              <a
                class="news-card__btn"
                href={routes.newsletter()}
              >
                Get the weekly newsletter <Icon name="arrow-right" size={11} />
              </a>
            </div>

            {/* Trending */}
            {trending.length > 0 ? (
              <div>
                <div class="side-head">
                  <Icon name="trending-up" size={12} class="is-accent" />
                  <span>Trending</span>
                </div>
                <div class="side-trending">
                  {trending.map((p, i) => (
                    <article class="side-trending__item">
                      <span class="side-trending__num" aria-hidden="true">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <CategoryTag name={p.categoryName} size="xs" />
                        <h4 class="side-trending__title">
                          <a href={routes.post(p.categorySlug, p.slug)}>
                            {cleanText(p.title)}
                          </a>
                        </h4>
                        {p.readingTime ? (
                          <div class="side-trending__meta">
                            <Icon name="clock" size={9} />
                            <span class="mono">{p.readingTime} min read</span>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {/* ── You might also like ── */}
      {related.length > 0 ? (
        <div class="related-band">
          <div class="container">
            <SectionHead icon="flame" accent label="You may also like" line />
            <div class="rel-grid">
              {related.slice(0, 3).map((p) => (
                <RelatedCard card={p} />
              ))}
            </div>
            <div class="btn-row">
              <a class="btn-outline" href={routes.home()}>
                All articles <Icon name="arrow-right" size={12} />
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {/* Back to top (fades in via CSS scroll-driven animation) */}
      <a class="scroll-top" href="#" aria-label="Back to top">
        <Icon name="arrow-up" size={16} />
      </a>
    </>
  );
}
