import { routes } from "../lib/config";
import { categorySolid } from "../lib/category";
import { uploadPath } from "../lib/images";
import { cleanText } from "../lib/sanitize";
import type { Category } from "../db/schema";
import type { Contributor, PostCard } from "../db/queries";
import {
  AuthorChip,
  CatCard,
  CategoryTag,
  CoverImage,
  LoadMoreLink,
  PostRow,
  SectionHead,
  formatViews,
} from "./components";
import { Icon } from "./icons";

export type CategorySort = "latest" | "popular" | "trending";
export type CategoryLayout = "grid" | "list";

interface TagChip {
  slug: string;
  name: string;
}

interface OtherCategory {
  slug: string;
  name: string;
  tagline: string | null;
  postCount: number;
}

export function CategoryPageView({
  category,
  banner,
  totalViews,
  featured,
  featuredTags,
  articles,
  totalRest,
  hasMore,
  hrefs,
  sort,
  layout,
  contributors,
  mostRead,
  catTags,
  others,
}: {
  category: Category;
  banner: PostCard | null;
  totalViews: number;
  featured: PostCard | null;
  featuredTags: TagChip[];
  articles: PostCard[];
  totalRest: number;
  hasMore: boolean;
  hrefs: {
    base: string;
    sort: Record<CategorySort, string>;
    layout: Record<CategoryLayout, string>;
    more: string;
  };
  sort: CategorySort;
  layout: CategoryLayout;
  contributors: Contributor[];
  mostRead: PostCard[];
  catTags: TagChip[];
  others: OtherCategory[];
}) {
  const solid = categorySolid(category.name);
  const bannerSrc = banner ? uploadPath(banner.coverImageKey) : null;
  const name = category.name;

  // Real numbers only: article count from the categories table, view total
  // summed over the category's posts (no invented social proof). Zero views
  // are hidden, matching the card convention elsewhere.
  const stats = [
    { icon: "book-open", value: String(category.postCount), label: "Articles" },
    ...(totalViews > 0
      ? [{ icon: "eye", value: formatViews(totalViews), label: "Views" }]
      : []),
  ];

  const sortOptions: { key: CategorySort; label: string }[] = [
    { key: "latest", label: "Latest" },
    { key: "popular", label: "Popular" },
    { key: "trending", label: "Trending" },
  ];

  return (
    <>
      {/* ── Category hero banner ── */}
      <div class="cat-hero">
        {bannerSrc ? (
          <img
            class="cat-hero__img"
            src={bannerSrc}
            alt=""
            width={1400}
            height={500}
            loading="eager"
            decoding="async"
          />
        ) : null}
        <div class="cat-hero__scrim" aria-hidden="true" />
        <span class="cat-hero__initial" aria-hidden="true">
          {name[0]}
        </span>
        <div class="cat-hero__inner">
          <div class="container cat-hero__body">
            <nav class="detail-crumb cat-hero__crumb" aria-label="Breadcrumb">
              <a href={routes.home()}>Home</a>
              <Icon name="chevron-right" size={9} />
              <span class="cat-hero__crumb-topics">Topics</span>
              <Icon name="chevron-right" size={9} />
              <span class="cat-hero__crumb-cat" style={`color:${solid}`}>
                {name.toUpperCase()}
              </span>
            </nav>
            <div class="cat-hero__row">
              <div class="cat-hero__main">
                <span class="cat-stripe" style={`background:${solid}`} aria-hidden="true" />
                <h1 class="cat-hero__title">{name}</h1>
                {category.description ? (
                  <p class="cat-hero__desc">{cleanText(category.description)}</p>
                ) : null}
                <div class="cat-hero__stats">
                  {stats.map((s) => (
                    <span class="cat-stat">
                      <Icon name={s.icon} size={12} />
                      <b>{s.value}</b>
                      <span class="mono">{s.label}</span>
                    </span>
                  ))}
                </div>
              </div>
              <a class="cat-follow" style={`background:${solid}`} href={routes.newsletter()}>
                <Icon name="bell" size={13} /> Follow {name}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sticky filter bar ── */}
      <div class="cat-filter">
        <div class="container cat-filter__inner">
          <div class="cat-tabs">
            <a class="cat-tab is-active" href={hrefs.base}>
              All
            </a>
            {catTags.map((t) => (
              <a class="cat-tab" href={routes.tag(t.slug)}>
                {t.name}
              </a>
            ))}
          </div>
          <div class="cat-controls">
            <div class="seg">
              {sortOptions.map((o) => (
                <a
                  class={sort === o.key ? "seg__btn is-active" : "seg__btn"}
                  href={hrefs.sort[o.key]}
                >
                  {o.label}
                </a>
              ))}
            </div>
            <div class="seg seg--icons">
              <a
                class={layout === "grid" ? "seg__btn is-active" : "seg__btn"}
                href={hrefs.layout.grid}
                aria-label="Grid view"
              >
                <Icon name="grid-3x3" size={13} />
              </a>
              <a
                class={layout === "list" ? "seg__btn is-active" : "seg__btn"}
                href={hrefs.layout.list}
                aria-label="List view"
              >
                <Icon name="rows-3" size={13} />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main + sidebar ── */}
      <div class="container cat-container">
        <div class="cat-cols">
          <div class="cat-main">
            {/* Featured in category */}
            {featured ? (
              <section class="cat-sect">
                <SectionHead icon="flame" accent label={`Featured in ${name}`} line />
                <article class="feat-cat">
                  <a
                    class="feat-cat__media"
                    href={routes.post(featured.categorySlug, featured.slug)}
                    tabindex={-1}
                    aria-hidden="true"
                  >
                    <CoverImage
                      imageKey={featured.coverImageKey}
                      alt={featured.coverImageAlt}
                      eager
                    />
                  </a>
                  <div class="feat-cat__body">
                    <div class="feat-cat__head">
                      <span class="feat-cat__bar" style={`background:${solid}`} aria-hidden="true" />
                      <div>
                        <CategoryTag name={featured.categoryName} pill />
                        <div class="feat-cat__pick mono">Editor's pick</div>
                      </div>
                    </div>
                    <h2 class="feat-cat__title">
                      <a href={routes.post(featured.categorySlug, featured.slug)}>
                        {cleanText(featured.title)}
                      </a>
                    </h2>
                    {featured.excerpt ? (
                      <p class="feat-cat__excerpt">{cleanText(featured.excerpt)}</p>
                    ) : null}
                    {featuredTags.length > 0 ? (
                      <div class="tag-chips feat-cat__tags">
                        {featuredTags.map((t) => (
                          <a class="tag-chip" href={routes.tag(t.slug)}>
                            {t.name}
                          </a>
                        ))}
                      </div>
                    ) : null}
                    <div class="feat-cat__meta">
                      {featured.authorName ? (
                        <>
                          <AuthorChip name={featured.authorName} />
                          <span class="feat-cat__who">
                            <b>{featured.authorName}</b>
                          </span>
                        </>
                      ) : null}
                      <span class="feat-cat__nums">
                        {featured.readingTime ? (
                          <span class="meta-time">
                            <Icon name="clock" size={10} />
                            <span class="mono">{featured.readingTime} min read</span>
                          </span>
                        ) : null}
                        {featured.viewCount ? (
                          <span class="meta-views">
                            <Icon name="eye" size={10} />
                            <span class="mono">{formatViews(featured.viewCount)}</span>
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </article>
              </section>
            ) : null}

            {/* All articles */}
            <section class="cat-sect">
              <SectionHead
                icon="trending-up"
                label={`All ${name} articles (${totalRest})`}
                line
              />
              {articles.length === 0 ? (
                <p class="empty">No articles yet.</p>
              ) : layout === "grid" ? (
                <div class="cat-grid">
                  {articles.map((p) => (
                    <CatCard card={p} />
                  ))}
                </div>
              ) : (
                <div class="cat-list">
                  {articles.map((p) => (
                    <PostRow card={p} />
                  ))}
                </div>
              )}
              {hasMore ? (
                <LoadMoreLink href={hrefs.more} />
              ) : articles.length > 0 ? (
                <div class="cat-end mono">
                  You have reached the end of {name} articles -{" "}
                  <a href="#">Back to top</a>
                </div>
              ) : null}
            </section>

            {/* Explore other topics */}
            {others.length > 0 ? (
              <section class="other-topics">
                <SectionHead icon="layout-grid" label="Explore other topics" />
                <div class="topics-grid">
                  {others.map((o) => (
                    <a class="topic-card" href={routes.category(o.slug)}>
                      <span
                        class="cat-stripe cat-stripe--sm"
                        style={`background:${categorySolid(o.name)}`}
                        aria-hidden="true"
                      />
                      <span class="topic-card__name">{o.name}</span>
                      {o.tagline ? (
                        <span class="topic-card__desc">{cleanText(o.tagline)}</span>
                      ) : null}
                      <span class="topic-card__count">
                        <Icon name="book-open" size={9} />
                        <span class="mono">{o.postCount} {o.postCount === 1 ? "article" : "articles"}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          {/* ── Sidebar ── */}
          <aside class="cat-side">
            <div class="cat-side__sticky">
              {/* About this topic */}
              <div class="about-card" style={`background:${solid}`}>
                <div class="about-card__label">About this topic</div>
                <p class="about-card__text">
                  {cleanText(category.tagline || category.description || "")}
                </p>
                <div class="about-card__stats">
                  {stats.map((s) => (
                    <div class="about-card__stat">
                      <b>{s.value}</b>
                      <span class="mono">{s.label.toUpperCase()}</span>
                    </div>
                  ))}
                </div>
                <a class="about-card__btn" href={routes.newsletter()}>
                  Follow {name}
                </a>
              </div>

              {/* Top contributors */}
              {contributors.length > 0 ? (
                <div>
                  <div class="side-head">
                    <Icon name="user" size={12} />
                    <span>Top writers</span>
                  </div>
                  <div class="contribs">
                    {contributors.map((a) => (
                      <a class="contrib" href={routes.author(a.slug)}>
                        <span class="contrib__avatar" style={`background:${solid}`}>
                          {a.name
                            .split(/\s+/)
                            .map((p) => p[0])
                            .join("")
                            .slice(0, 2)
                            .toUpperCase()}
                        </span>
                        <span class="contrib__who">
                          <b>{a.name}</b>
                        </span>
                        <span class="contrib__n">
                          <b>{a.count}</b>
                          <span class="mono">articles</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}

              <div class="sidebar__divider" />

              {/* Most read */}
              {mostRead.length > 0 ? (
                <div>
                  <div class="side-head">
                    <Icon name="trending-up" size={12} class="is-accent" />
                    <span>Most read</span>
                  </div>
                  <div class="most-read">
                    {mostRead.map((p, i) => (
                      <article class="most-read__item">
                        <span class="most-read__num" aria-hidden="true">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <h4 class="most-read__title">
                            <a href={routes.post(p.categorySlug, p.slug)}>
                              {cleanText(p.title)}
                            </a>
                          </h4>
                          <div class="most-read__meta">
                            {p.viewCount ? (
                              <span class="meta-views">
                                <Icon name="eye" size={9} />
                                <span class="mono">{formatViews(p.viewCount)}</span>
                              </span>
                            ) : null}
                            <span class="meta-sep" aria-hidden="true" />
                            {p.readingTime ? (
                              <span class="meta-time">
                                <Icon name="clock" size={9} />
                                <span class="mono">{p.readingTime} min read</span>
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              <div class="sidebar__divider" />

              {/* Popular tags */}
              {catTags.length > 0 ? (
                <div>
                  <div class="side-head">
                    <Icon name="tag" size={11} />
                    <span>Popular tags</span>
                  </div>
                  <div class="topics">
                    {catTags.map((t) => (
                      <a class="topic-btn" href={routes.tag(t.slug)}>
                        {t.name}
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}

              <div class="sidebar__divider" />

              {/* Newsletter */}
              <div class="news-card news-card--mini">
                <Icon name="bell" size={13} class="is-accent" />
                <h3 class="news-card__title">Get the best of {name}.</h3>
                <p class="news-card__text">
                  A weekly roundup of the best {name} articles. No spam.
                </p>
                <form class="news-card__form" action="/newsletter" method="get">
                  <input
                    type="email"
                    name="email"
                    placeholder="ban@email.com"
                    aria-label="Email address"
                  />
                  <button type="submit">Subscribe free</button>
                </form>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
