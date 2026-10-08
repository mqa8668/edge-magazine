import { raw } from "hono/html";
import { routes } from "../lib/config";
import { cleanText } from "../lib/sanitize";
import type { PostCard, ClusterSummary } from "../db/queries";
import { CatCard, SharedSidebar, NewsletterCard } from "./components";
import { Icon } from "./icons";

interface ClusterRow {
  slug: string;
  name: string;
  description: string | null;
  introHtml: string | null;
  pillarKeyword: string | null;
}

// Pillar (hub) page for one topic cluster: an LLM-written overview + every spoke
// article. This is the page that concentrates topical authority for the theme.
export function ClusterHubView({
  cluster,
  spokes,
  trending,
  popularTags,
}: {
  cluster: ClusterRow;
  spokes: PostCard[];
  trending: PostCard[];
  popularTags: { slug: string; name: string }[];
}) {
  return (
    <>
      <div class="tag-hero">
        <div class="container tag-hero__inner">
          <nav class="detail-crumb tag-hero__crumb" aria-label="Breadcrumb">
            <a href={routes.home()}>Home</a>
            <Icon name="chevron-right" size={9} />
            <a href={routes.clusters()}>Topics</a>
            <Icon name="chevron-right" size={9} />
            <span class="tag-hero__crumb-tag">{cluster.name.toUpperCase()}</span>
          </nav>
          <div class="tag-hero__row">
            <div class="tag-hero__main">
              <div class="tag-hero__name">
                <span class="tag-hero__hash" aria-hidden="true">
                  <Icon name="layout-grid" size={18} />
                </span>
                <h1 class="tag-hero__title">{cluster.name}</h1>
              </div>
              {cluster.description ? (
                <p class="tag-hero__desc">{cleanText(cluster.description)}</p>
              ) : null}
              <div class="cat-hero__stats">
                <span class="cat-stat">
                  <Icon name="book-open" size={12} />
                  <b>{spokes.length}</b>
                  <span class="mono">Articles</span>
                </span>
              </div>
            </div>
            <a class="tag-hero__follow" href={routes.newsletter()}>
              <Icon name="bell" size={13} /> Follow topic
            </a>
          </div>
        </div>
      </div>

      <div class="container cat-container">
        <div class="cat-cols">
          <div class="cat-main">
            {cluster.introHtml ? (
              <div
                class="prose cluster-intro"
                dangerouslySetInnerHTML={{
                  __html: raw(cluster.introHtml) as unknown as string,
                }}
              />
            ) : null}

            <div class="sect-head">
              <Icon name="layout-grid" size={13} class="sect-head__icon" />
              <span class="sect-head__label">
                All articles in this topic ({spokes.length})
              </span>
              <span class="sect-head__line" aria-hidden="true" />
            </div>

            {spokes.length === 0 ? (
              <div class="search-empty">
                <p class="search-empty__text mono">No articles yet.</p>
              </div>
            ) : (
              <div class="cat-grid">
                {spokes.map((p) => (
                  <CatCard card={p} />
                ))}
              </div>
            )}

            <NewsletterCard />
          </div>

          <aside class="cat-side">
            <SharedSidebar trending={trending} tags={popularTags} />
          </aside>
        </div>
      </div>
    </>
  );
}

// The cluster index at /clusters: every populated cluster as a card.
export function ClusterIndexView({ clusters }: { clusters: ClusterSummary[] }) {
  return (
    <>
      <div class="tag-hero">
        <div class="container tag-hero__inner">
          <nav class="detail-crumb tag-hero__crumb" aria-label="Breadcrumb">
            <a href={routes.home()}>Home</a>
            <Icon name="chevron-right" size={9} />
            <span class="tag-hero__crumb-tag">TOPIC</span>
          </nav>
          <div class="tag-hero__row">
            <div class="tag-hero__main">
              <div class="tag-hero__name">
                <span class="tag-hero__hash" aria-hidden="true">
                  <Icon name="layout-grid" size={18} />
                </span>
                <h1 class="tag-hero__title">Topic Hubs</h1>
              </div>
              <p class="tag-hero__desc">
                Article clusters grouped by topic so you can go deep on one thread at a time.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="container cat-container">
        {clusters.length === 0 ? (
          <div class="search-empty">
            <p class="search-empty__text mono">No topics yet.</p>
          </div>
        ) : (
          <div class="cluster-index">
            {clusters.map((c) => (
              <a class="cluster-card" href={routes.cluster(c.slug)}>
                <div class="cluster-card__head">
                  <Icon name="layout-grid" size={15} />
                  <h2 class="cluster-card__name">{c.name}</h2>
                </div>
                {c.description ? (
                  <p class="cluster-card__desc">{cleanText(c.description)}</p>
                ) : null}
                <span class="cluster-card__count mono">
                  {c.spokeCount} {c.spokeCount === 1 ? "article" : "articles"}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
