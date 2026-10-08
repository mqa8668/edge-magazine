import { routes } from "../lib/config";
import { cleanText } from "../lib/sanitize";
import type { Tag } from "../db/schema";
import type { PostCard } from "../db/queries";
import {
  CatCard,
  LoadMoreLink,
  PostRow,
  SharedSidebar,
} from "./components";
import { Icon } from "./icons";

export type TagSort = "latest" | "popular";
export type TagLayout = "grid" | "list";

interface TagChip {
  slug: string;
  name: string;
}

export function TagPageView({
  tag,
  articles,
  total,
  hasMore,
  hrefs,
  sort,
  layout,
  relatedTags,
  cloudTags,
  moreTags,
  trending,
  popularTags,
}: {
  tag: Tag;
  articles: PostCard[];
  total: number;
  hasMore: boolean;
  hrefs: {
    sort: Record<TagSort, string>;
    layout: Record<TagLayout, string>;
    more: string;
  };
  sort: TagSort;
  layout: TagLayout;
  relatedTags: TagChip[];
  cloudTags: { slug: string; name: string; usageCount: number }[];
  moreTags: { slug: string; name: string; usageCount: number }[];
  trending: PostCard[];
  popularTags: TagChip[];
}) {
  const sortOptions: { key: TagSort; label: string }[] = [
    { key: "latest", label: "Latest" },
    { key: "popular", label: "Popular" },
  ];

  return (
    <>
      {/* ── Tag hero ── */}
      <div class="tag-hero">
        <div class="container tag-hero__inner">
          <nav class="detail-crumb tag-hero__crumb" aria-label="Breadcrumb">
            <a href={routes.home()}>Home</a>
            <Icon name="chevron-right" size={9} />
            <span class="tag-hero__crumb-mid">Tags</span>
            <Icon name="chevron-right" size={9} />
            <span class="tag-hero__crumb-tag">{tag.name.toUpperCase()}</span>
          </nav>
          <div class="tag-hero__row">
            <div class="tag-hero__main">
              <div class="tag-hero__name">
                <span class="tag-hero__hash" aria-hidden="true">
                  <Icon name="hash" size={18} />
                </span>
                <h1 class="tag-hero__title">#{tag.name}</h1>
              </div>
              {tag.description ? (
                <p class="tag-hero__desc">{cleanText(tag.description)}</p>
              ) : null}
              <div class="cat-hero__stats">
                <span class="cat-stat">
                  <Icon name="book-open" size={12} />
                  <b>{total}</b>
                  <span class="mono">Articles</span>
                </span>
              </div>
            </div>
            <a class="tag-hero__follow" href={routes.newsletter()}>
              <Icon name="bell" size={13} /> Follow tag
            </a>
          </div>

          {relatedTags.length > 0 ? (
            <div class="tag-hero__related">
              <span class="tag-hero__related-label">Related tags:</span>
              {relatedTags.map((t) => (
                <a class="tag-hero__related-pill" href={routes.tag(t.slug)}>
                  <Icon name="hash" size={9} /> {t.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Sticky filter bar ── */}
      <div class="cat-filter">
        <div class="container cat-filter__inner">
          <span class="tag-filter__count mono">
            {total} {total === 1 ? "article" : "articles"} tagged <strong>#{tag.name}</strong>
          </span>
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

      {/* ── Articles + sidebar ── */}
      <div class="container cat-container">
        <div class="cat-cols">
          <div class="cat-main">
            {articles.length === 0 ? (
              <div class="search-empty">
                <Icon name="hash" size={32} class="search-empty__icon" />
                <p class="search-empty__text mono">
                  No articles with this tag yet.
                </p>
              </div>
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
            {hasMore ? <LoadMoreLink href={hrefs.more} /> : null}

            {/* Browse all tags: established tags up front, one-post tags
                collapsed behind a native <details> disclosure. */}
            <div class="tag-cloud">
              <div class="sect-head">
                <Icon name="hash" size={13} class="sect-head__icon" />
                <span class="sect-head__label">Browse all tags</span>
              </div>
              <div class="tag-cloud__list">
                {cloudTags.map((t) => (
                  <a
                    class={
                      t.slug === tag.slug
                        ? "tag-cloud__item is-active"
                        : "tag-cloud__item"
                    }
                    href={routes.tag(t.slug)}
                  >
                    #{t.name} <span class="tag-cloud__n">{t.usageCount}</span>
                  </a>
                ))}
              </div>
              {moreTags.length > 0 ? (
                <details class="tag-cloud__extra">
                  <summary class="tag-cloud__toggle mono">
                    <span class="tag-cloud__toggle-open">
                      Show {moreTags.length} more tags
                    </span>
                    <span class="tag-cloud__toggle-close">Show less</span>
                    <Icon name="chevron-right" size={9} class="tag-cloud__toggle-icon" />
                  </summary>
                  <div class="tag-cloud__list tag-cloud__list--extra">
                    {moreTags.map((t) => (
                      <a class="tag-cloud__item" href={routes.tag(t.slug)}>
                        #{t.name} <span class="tag-cloud__n">{t.usageCount}</span>
                      </a>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </div>

          <aside class="cat-side">
            <SharedSidebar trending={trending} tags={popularTags} />
          </aside>
        </div>
      </div>
    </>
  );
}
