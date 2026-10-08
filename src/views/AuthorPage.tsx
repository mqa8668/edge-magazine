import { routes } from "../lib/config";
import { uploadPath } from "../lib/images";
import { cleanText } from "../lib/sanitize";
import type { Author } from "../db/schema";
import type { PostCard } from "../db/queries";
import { CatCard, LoadMoreLink, SharedSidebar } from "./components";
import { Icon } from "./icons";

export type AuthorSort = "latest" | "popular";
export type AuthorTab = "articles" | "about";

function parseJsonList(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function AuthorPageView({
  author,
  totalViews,
  articles,
  total,
  hasMore,
  hrefs,
  sort,
  tab,
  otherAuthors,
  trending,
  popularTags,
}: {
  author: Author;
  totalViews: string;
  articles: PostCard[];
  total: number;
  hasMore: boolean;
  hrefs: {
    articles: string;
    about: string;
    sort: Record<AuthorSort, string>;
    more: string;
  };
  sort: AuthorSort;
  tab: AuthorTab;
  otherAuthors: Author[];
  trending: PostCard[];
  popularTags: { slug: string; name: string }[];
}) {
  const avatar = author.avatarKey ? uploadPath(author.avatarKey) : null;
  const expertise = parseJsonList(author.expertise);
  const featuredIn = parseJsonList(author.featuredIn);
  const twitterUrl = author.twitter
    ? `https://twitter.com/${author.twitter.replace(/^@/, "")}`
    : null;
  const websiteUrl = author.website ? `https://${author.website}` : null;

  // Real numbers only (no invented follower counts).
  const stats = [
    { label: "Articles", value: String(author.postCount) },
    { label: "Views", value: totalViews },
  ];

  return (
    <>
      {/* ── Author hero ── */}
      <div class="author-hero">
        <div class="container author-hero__inner">
          <nav class="detail-crumb author-hero__crumb" aria-label="Breadcrumb">
            <a href={routes.home()}>Home</a>
            <Icon name="chevron-right" size={9} />
            <span class="author-hero__crumb-mid">Authors</span>
            <Icon name="chevron-right" size={9} />
            <span class="author-hero__crumb-name">
              {author.name.toUpperCase().replace(/\s+/g, "_")}
            </span>
          </nav>

          <div class="author-hero__row">
            <div class="author-hero__avatar-wrap">
              {avatar ? (
                <img
                  class="author-hero__avatar"
                  src={avatar}
                  alt={author.name}
                  width={112}
                  height={112}
                  loading="eager"
                />
              ) : null}
              <span class="author-hero__dot" title="Active" aria-hidden="true" />
            </div>

            <div class="author-hero__info">
              <div class="author-hero__top">
                <div>
                  <h1 class="author-hero__name">{author.name}</h1>
                  <div class="author-hero__meta">
                    {author.role ? (
                      <span class="author-hero__role mono">
                        {cleanText(author.role)}
                      </span>
                    ) : null}
                    {author.location ? (
                      <>
                        <span class="meta-sep meta-sep--light" aria-hidden="true" />
                        <span class="mono">{author.location}</span>
                      </>
                    ) : null}
                    {author.joined ? (
                      <>
                        <span class="meta-sep meta-sep--light" aria-hidden="true" />
                        <span class="mono">Tham gia {author.joined}</span>
                      </>
                    ) : null}
                  </div>
                  {author.shortBio ? (
                    <p class="author-hero__bio">{cleanText(author.shortBio)}</p>
                  ) : null}
                  <div class="author-hero__social">
                    {twitterUrl ? (
                      <a href={twitterUrl} target="_blank" rel="noopener nofollow">
                        <Icon name="twitter" size={12} /> {author.twitter}
                      </a>
                    ) : null}
                    {websiteUrl ? (
                      <a href={websiteUrl} target="_blank" rel="noopener nofollow">
                        <Icon name="globe" size={12} /> {author.website}
                      </a>
                    ) : null}
                    <a href="/feed.xml">
                      <Icon name="rss" size={12} /> RSS
                    </a>
                  </div>
                </div>
                <div class="author-hero__actions">
                  <a class="author-hero__follow" href={routes.newsletter()}>
                    <Icon name="bell" size={12} /> Follow
                  </a>
                  <a
                    class="author-hero__share"
                    href={`mailto:?subject=${encodeURIComponent(`Articles by ${author.name}`)}`}
                    aria-label="Share"
                  >
                    <Icon name="share-2" size={14} />
                  </a>
                </div>
              </div>

              <div class="author-hero__stats">
                {stats.map((s) => (
                  <div class="author-hero__stat">
                    <b>{s.value}</b>
                    <span class="mono">{s.label.toUpperCase()}</span>
                  </div>
                ))}
              </div>

              {featuredIn.length > 0 ? (
                <div class="author-hero__seen">
                  <span class="author-hero__seen-label">Featured in:</span>
                  {featuredIn.map((pub) => (
                    <span class="author-hero__pub">{pub}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs bar ── */}
      <div class="cat-filter">
        <div class="container cat-filter__inner">
          <div class="cat-tabs">
            <a
              class={tab === "articles" ? "cat-tab is-active" : "cat-tab"}
              href={hrefs.articles}
            >
              Articles ({total})
            </a>
            <a
              class={tab === "about" ? "cat-tab is-active" : "cat-tab"}
              href={hrefs.about}
            >
              About
            </a>
          </div>
          {tab === "articles" ? (
            <div class="cat-controls">
              <div class="seg">
                {(
                  [
                    { key: "latest", label: "Latest" },
                    { key: "popular", label: "Popular" },
                  ] as { key: AuthorSort; label: string }[]
                ).map((o) => (
                  <a
                    class={sort === o.key ? "seg__btn is-active" : "seg__btn"}
                    href={hrefs.sort[o.key]}
                  >
                    {o.label}
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Content + sidebar ── */}
      <div class="container cat-container">
        <div class="cat-cols">
          <div class="cat-main">
            {tab === "articles" ? (
              <>
                <div class="search-grid">
                  {articles.map((p) => (
                    <CatCard card={p} />
                  ))}
                </div>
                {hasMore ? <LoadMoreLink href={hrefs.more} /> : null}
              </>
            ) : (
              <div class="author-about">
                {author.bio ? (
                  <div>
                    <h2 class="author-about__head mono">Bio</h2>
                    <p class="author-about__bio">{cleanText(author.bio)}</p>
                  </div>
                ) : null}
                {expertise.length > 0 ? (
                  <>
                    <div class="sidebar__divider" />
                    <div>
                      <h2 class="author-about__head mono">Areas of expertise</h2>
                      <div class="author-about__chips">
                        {expertise.map((e) => (
                          <span class="author-about__chip mono">{e}</span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}
                {featuredIn.length > 0 ? (
                  <>
                    <div class="sidebar__divider" />
                    <div>
                      <h2 class="author-about__head mono">Featured in</h2>
                      <div class="author-about__pubs">
                        {featuredIn.map((pub) => (
                          <span class="author-about__pub">
                            <Icon name="star" size={12} class="is-star" />
                            <b>{pub}</b>
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}
                <div class="sidebar__divider" />
                <div>
                  <h2 class="author-about__head mono">Links & social</h2>
                  <div class="author-about__contacts">
                    {twitterUrl ? (
                      <a class="contact-row" href={twitterUrl} target="_blank" rel="noopener nofollow">
                        <span class="contact-row__icon">
                          <Icon name="twitter" size={14} />
                        </span>
                        <span class="contact-row__body">
                          <span class="contact-row__label mono">Twitter</span>
                          <span class="contact-row__value">{author.twitter}</span>
                        </span>
                      </a>
                    ) : null}
                    {websiteUrl ? (
                      <a class="contact-row" href={websiteUrl} target="_blank" rel="noopener nofollow">
                        <span class="contact-row__icon">
                          <Icon name="globe" size={14} />
                        </span>
                        <span class="contact-row__body">
                          <span class="contact-row__label mono">Website</span>
                          <span class="contact-row__value">{author.website}</span>
                        </span>
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside class="cat-side">
            <div class="cat-side__sticky">
              {otherAuthors.length > 0 ? (
                <div>
                  <div class="side-head">
                    <Icon name="users" size={12} />
                    <span>More authors</span>
                  </div>
                  <div class="contribs">
                    {otherAuthors.map((a) => {
                      const av = a.avatarKey ? uploadPath(a.avatarKey) : null;
                      return (
                        <a class="contrib" href={routes.author(a.slug)}>
                          {av ? (
                            <img
                              class="contrib__img"
                              src={av}
                              alt={a.name}
                              width={36}
                              height={36}
                              loading="lazy"
                            />
                          ) : null}
                          <span class="contrib__who">
                            <b>{a.name}</b>
                            {a.role ? (
                              <span class="mono">{cleanText(a.role)}</span>
                            ) : null}
                          </span>
                          <span class="contrib__n">
                            <b>{a.postCount}</b>
                            <span class="mono">articles</span>
                          </span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div class="sidebar__divider" />
              <SharedSidebar trending={trending} tags={popularTags} />
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
