import { routes } from "../lib/config";
import type { PostCard } from "../db/queries";
import {
  CatCard,
  LoadMoreLink,
  PostRow,
  SharedSidebar,
} from "./components";
import { Icon } from "./icons";

export type SearchSort = "relevance" | "latest" | "popular";
export type SearchLayout = "list" | "grid";

const SUGGESTIONS = [
  "Deep work",
  "Morning routine",
  "Sleep",
  "Procrastination",
  "Mindfulness",
  "Time blocking",
  "Habits",
  "Focus",
];

interface TagChip {
  slug: string;
  name: string;
}

export function SearchPageView({
  q,
  results,
  total,
  hasMore,
  hrefs,
  sort,
  layout,
  cat,
  relatedTags,
  trending,
  popularTags,
}: {
  q: string;
  results: PostCard[];
  total: number;
  hasMore: boolean;
  hrefs: {
    sort: Record<SearchSort, string>;
    layout: Record<SearchLayout, string>;
    cat: { slug: string; name: string; href: string }[];
    more: string;
    suggestion: (s: string) => string;
  };
  sort: SearchSort;
  layout: SearchLayout;
  cat: string;
  relatedTags: TagChip[];
  trending: PostCard[];
  popularTags: TagChip[];
}) {
  const sortOptions: { key: SearchSort; label: string }[] = [
    { key: "relevance", label: "Relevance" },
    { key: "latest", label: "Newest" },
    { key: "popular", label: "Popular" },
  ];

  return (
    <>
      {/* ── Search hero ── */}
      <div class="search-hero">
        <div class="search-hero__inner">
          <div class="search-hero__label">
            <Icon name="search" size={13} />
            <span>Search</span>
          </div>
          <form class="search-big" action={routes.search()} method="get" role="search">
            <div class="search-big__field">
              <Icon name="search" size={16} />
              <input
                type="search"
                name="q"
                value={q}
                placeholder="Search articles, topics, authors..."
                aria-label="Search"
                minlength={2}
              />
            </div>
            <button type="submit">Search</button>
          </form>
          <div class="search-try">
            <span class="search-try__label">Try:</span>
            {SUGGESTIONS.map((s) => (
              <a
                class={
                  q.toLowerCase() === s.toLowerCase()
                    ? "search-try__pill is-active"
                    : "search-try__pill"
                }
                href={hrefs.suggestion(s)}
              >
                {s}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* ── Results + sidebar ── */}
      <div class="container search-container">
        <div class="cat-cols">
          <div class="cat-main">
            {/* Results head + controls */}
            <div class="search-head">
              <div>
                {q ? (
                  <>
                    <h1 class="search-head__title">
                      Results for "<span class="is-accent-text">{q}</span>"
                    </h1>
                    <p class="search-head__count mono">
                      {total} {total === 1 ? "article" : "articles"} found
                    </p>
                  </>
                ) : (
                  <h1 class="search-head__title">All articles</h1>
                )}
              </div>
              <div class="search-controls">
                <div class="filter-pills">
                  {hrefs.cat.map((o) => (
                    <a
                      class={cat === o.slug ? "pill is-active" : "pill"}
                      href={o.href}
                    >
                      {o.name}
                    </a>
                  ))}
                </div>
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
                    class={layout === "list" ? "seg__btn is-active" : "seg__btn"}
                    href={hrefs.layout.list}
                    aria-label="List view"
                  >
                    <Icon name="rows-3" size={13} />
                  </a>
                  <a
                    class={layout === "grid" ? "seg__btn is-active" : "seg__btn"}
                    href={hrefs.layout.grid}
                    aria-label="Grid view"
                  >
                    <Icon name="grid-3x3" size={13} />
                  </a>
                </div>
              </div>
            </div>

            {/* Related tags strip */}
            {q && relatedTags.length > 0 ? (
              <div class="search-related">
                <span class="search-related__label">Related:</span>
                {relatedTags.map((t) => (
                  <a class="search-related__tag" href={routes.tag(t.slug)}>
                    <Icon name="hash" size={9} /> {t.name}
                  </a>
                ))}
              </div>
            ) : null}

            {/* Results */}
            {results.length === 0 ? (
              <div class="search-empty">
                <Icon name="search" size={32} class="search-empty__icon" />
                <h3 class="search-empty__title">No results for "{q}"</h3>
                <p class="search-empty__text">
                  Try a different keyword or browse by category.
                </p>
                <div class="search-empty__sugs">
                  {SUGGESTIONS.slice(0, 5).map((s) => (
                    <a class="search-empty__sug" href={hrefs.suggestion(s)}>
                      {s}
                    </a>
                  ))}
                </div>
              </div>
            ) : layout === "list" ? (
              <div class="cat-list">
                {results.map((p) => (
                  <PostRow card={p} highlight={q || undefined} />
                ))}
              </div>
            ) : (
              <div class="search-grid">
                {results.map((p) => (
                  <CatCard card={p} highlight={q || undefined} />
                ))}
              </div>
            )}
            {hasMore ? <LoadMoreLink href={hrefs.more} /> : null}
          </div>

          <aside class="cat-side">
            <SharedSidebar trending={trending} tags={popularTags} />
          </aside>
        </div>
      </div>
    </>
  );
}
