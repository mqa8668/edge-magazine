import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getHomeData,
  getNavCategories,
  getTopTags,
  type PostCard,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import {
  HeroMain,
  HeroOverlayCard,
  LoadMoreLink,
  MostSavedList,
  NewsletterCard,
  PickCard,
  PostGrid,
  SectionHead,
  TrendingList,
} from "../views/components";
import * as ld from "../seo/structured-data";

// Latest grid page size; "Load more" renders cumulatively (page*8 cards),
// mirroring the Figma prototype's visibleCount behavior.
const LATEST_PER_PAGE = 8;

export async function homeRoute(c: Context<AppEnv>) {
  return withEdgeCache(c, TTL.content, async () => {
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const d = db(c.env.DB);
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const [nav, topics, data] = await Promise.all([
      getNavCategories(d),
      getTopTags(d, 10),
      getHomeData(d),
    ]);

    // Featured pool: lead hero + 2 secondary + 4 editor's picks, deduped so
    // the Latest grid never repeats them.
    const pool = data.featured.length ? data.featured : data.recent;
    const lead = pool[0] ?? data.recent[0];
    const used = new Set<number>(lead ? [lead.id] : []);
    const pick = (n: number, from: PostCard[]) => {
      const out: PostCard[] = [];
      for (const p of from) {
        if (out.length >= n) break;
        if (!used.has(p.id)) {
          out.push(p);
          used.add(p.id);
        }
      }
      return out;
    };
    const secondary = pick(2, [...pool.slice(1), ...data.recent]);
    const editorsPicks = pick(4, pool.slice(1));

    const latestAll = data.recent.filter((p) => !used.has(p.id));
    const latestPool = latestAll.length ? latestAll : data.recent;
    const latest = latestPool.slice(0, page * LATEST_PER_PAGE);
    const hasMore = latestPool.length > latest.length;
    const mostSaved = latestPool.slice(0, 4);

    const listItems = (posts: PostCard[]) =>
      posts.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
        name: p.title,
      }));

    const meta = {
      title: pageTitle(site, "", true),
      description: site.description,
      canonical: `${site.url}/`,
      ogType: "website" as const,
      twitterCard: "summary_large_image" as const,
      jsonLd: [
        ld.organization(site),
        ld.website(site),
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Featured articles",
          itemListElement: listItems(pool.slice(0, 7)),
        },
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Latest articles",
          itemListElement: listItems(latest),
        },
      ],
    };

    const body = (
      <>
        {/* Featured stories */}
        <section class="home-sect">
          <SectionHead
            icon="flame"
            accent
            label="Featured articles"
            line
            seeAllHref="#latest"
          />
          <div class="hero">
            {lead ? <HeroMain card={lead} /> : null}
            <div class="hero-secondary">
              {secondary.map((p) => (
                <HeroOverlayCard card={p} />
              ))}
            </div>
          </div>
        </section>

        {/* Editor's picks */}
        {editorsPicks.length ? (
          <section class="home-sect">
            <SectionHead icon="tag" label="Editor's picks" line />
            <div class="picks-grid">
              {editorsPicks.map((p) => (
                <PickCard card={p} />
              ))}
            </div>
          </section>
        ) : null}

        {/* Latest + sidebar */}
        <div class="layout-cols" id="latest">
          <section class="content-col">
            <div class="list-head">
              <SectionHead icon="trending-up" label="Latest articles" />
              <div class="filter-pills">
                <a class="pill is-active" href={routes.home()}>
                  All
                </a>
                {nav.map((cat) => (
                  <a class="pill" href={routes.category(cat.slug)}>
                    {cat.name}
                  </a>
                ))}
              </div>
            </div>
            <PostGrid posts={latest} />
            {hasMore ? <LoadMoreLink href={`/?page=${page + 1}#latest`} /> : null}
          </section>

          <aside class="sidebar">
            <div>
              <SectionHead icon="trending-up" accent label="Trending now" />
              <TrendingList posts={data.popular} />
            </div>
            <div class="sidebar__divider" />
            <div>
              <SectionHead label="Browse by topic" />
              <div class="topics">
                {topics.map((t) => (
                  <a class="topic-btn" href={routes.tag(t.slug)}>
                    {t.name}
                  </a>
                ))}
              </div>
            </div>
            <div class="sidebar__divider" />
            <NewsletterCard />
            <div class="sidebar__divider" />
            <div>
              <SectionHead icon="bookmark" label="Most saved" />
              <MostSavedList posts={mostSaved} />
            </div>
          </aside>
        </div>
      </>
    );

    return renderPage(c, { site, meta, nav, body });
  });
}
