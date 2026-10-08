import type { Context } from "hono";
import type { AppEnv } from "../env";
import { db } from "../db/client";
import {
  getClusterBySlug,
  getClusterSpokes,
  getNavCategories,
  getPopularPosts,
  getTopTags,
  listClusters,
} from "../db/queries";
import { routes, siteConfig } from "../lib/config";
import { withEdgeCache, TTL } from "../lib/cache";
import { renderPage, pageTitle } from "../views/render";
import { ClusterHubView, ClusterIndexView } from "../views/ClusterPage";
import { notFound } from "./_shared";
import * as ld from "../seo/structured-data";

// /clusters - index of every populated topic cluster.
export async function clustersIndexRoute(c: Context<AppEnv>) {
  const d = db(c.env.DB);
  return withEdgeCache(c, TTL.content, async () => {
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const [nav, clusters] = await Promise.all([getNavCategories(d), listClusters(d)]);
    const path = routes.clusters();
    const meta = {
      title: pageTitle(site, "Topic Hubs"),
      description:
        `Article clusters grouped by topic on ${site.name}, so you can go deep on one thread at a time.`,
      canonical: `${site.url}${path}`,
      ogType: "website" as const,
      jsonLd: [
        ld.breadcrumb([
          { name: "Home", url: site.url },
          { name: "Topics", url: `${site.url}${path}` },
        ]),
        ld.collectionPage({
          name: "Topic Hubs",
          url: `${site.url}${path}`,
          items: clusters.map((cl) => ({
            url: `${site.url}${routes.cluster(cl.slug)}`,
            name: cl.name,
          })),
        }),
      ],
    };
    return renderPage(c, {
      site,
      meta,
      nav,
      body: <ClusterIndexView clusters={clusters} />,
      bare: true,
    });
  });
}

// /clusters/:slug - one cluster's pillar hub page.
export async function clusterRoute(c: Context<AppEnv>) {
  const slug = c.req.param("slug") ?? "";
  const d = db(c.env.DB);
  const cluster = await getClusterBySlug(d, slug);
  if (!cluster) return notFound(c);

  return withEdgeCache(c, TTL.content, async () => {
    const site = siteConfig(c.env, new URL(c.req.url).origin);
    const [nav, spokes, trending, popularTags] = await Promise.all([
      getNavCategories(d),
      getClusterSpokes(d, cluster.id, { limit: 60 }),
      getPopularPosts(d, 5),
      getTopTags(d, 8),
    ]);
    const path = routes.cluster(slug);
    const description = cluster.description || `Articles about ${cluster.name}.`;
    const meta = {
      title: pageTitle(site, cluster.name),
      description,
      canonical: `${site.url}${path}`,
      ogType: "website" as const,
      jsonLd: [
        ld.breadcrumb([
          { name: "Home", url: site.url },
          { name: "Topics", url: `${site.url}${routes.clusters()}` },
          { name: cluster.name, url: `${site.url}${path}` },
        ]),
        ld.collectionPage({
          name: cluster.name,
          description: cluster.description,
          url: `${site.url}${path}`,
          items: spokes.map((p) => ({
            url: `${site.url}${routes.post(p.categorySlug, p.slug)}`,
            name: p.title,
          })),
        }),
      ],
    };
    const body = (
      <ClusterHubView
        cluster={{
          slug: cluster.slug,
          name: cluster.name,
          description: cluster.description,
          introHtml: cluster.introHtml,
          pillarKeyword: cluster.pillarKeyword,
        }}
        spokes={spokes}
        trending={trending}
        popularTags={popularTags}
      />
    );
    return renderPage(c, { site, meta, nav, body, bare: true });
  });
}
