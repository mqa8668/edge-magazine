import { raw } from "hono/html";
import type { SiteConfig } from "../lib/config";

export interface PageMeta {
  title: string; // full <title> text (suffix already applied)
  description: string;
  canonical: string; // absolute URL
  ogType: "website" | "article";
  ogImage?: string; // absolute URL (falls back to site default)
  ogImageAlt?: string;
  twitterCard?: "summary" | "summary_large_image";
  noindex?: boolean;
  prevUrl?: string;
  nextUrl?: string;
  article?: {
    publishedTime: string;
    modifiedTime?: string;
    author?: string | null;
    section?: string | null;
  };
  jsonLd?: Record<string, unknown>[];
}

// Serialize JSON-LD safely for an inline <script> (escape the `<` in </script>).
function ldJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

export function Head({ site, meta }: { site: SiteConfig; meta: PageMeta }) {
  const ogImage = meta.ogImage || site.defaultOgImage;
  // Default to the large card: every page now has a 1200x630 OG image (branded
  // default or the article cover), which is what summary_large_image expects.
  const twitterCard = meta.twitterCard ?? "summary_large_image";
  const robots = meta.noindex ? "noindex, follow" : "index, follow";

  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{meta.title}</title>
      <meta name="description" content={meta.description} />
      <link rel="canonical" href={meta.canonical} />
      <meta name="referrer" content="strict-origin-when-cross-origin" />
      <meta name="robots" content={robots} />
      <meta name="theme-color" content={site.themeColor} />

      {/* Icons / manifest / feed */}
      <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.json" />
      <link
        rel="alternate"
        type="application/rss+xml"
        title={`${site.name} RSS Feed`}
        href={`${site.url}/feed.xml`}
      />

      {/* Fonts: Playfair Display (display), Inter (body), DM Mono (labels) */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,700;0,800;1,700&family=DM+Mono:wght@400;500&display=swap"
      />
      <link rel="stylesheet" href="/styles.css" />

      {/* Pagination hints */}
      {meta.prevUrl ? <link rel="prev" href={meta.prevUrl} /> : null}
      {meta.nextUrl ? <link rel="next" href={meta.nextUrl} /> : null}

      {/* Open Graph */}
      <meta property="og:type" content={meta.ogType} />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.description} />
      <meta property="og:url" content={meta.canonical} />
      <meta property="og:site_name" content={site.name} />
      <meta property="og:locale" content={site.locale} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:image:secure_url" content={ogImage} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      {meta.ogImageAlt ? (
        <meta property="og:image:alt" content={meta.ogImageAlt} />
      ) : null}

      {/* Article-specific OG */}
      {meta.article ? (
        <>
          <meta
            property="article:published_time"
            content={meta.article.publishedTime}
          />
          {meta.article.modifiedTime ? (
            <meta
              property="article:modified_time"
              content={meta.article.modifiedTime}
            />
          ) : null}
          {meta.article.author ? (
            <meta property="article:author" content={meta.article.author} />
          ) : null}
          {meta.article.section ? (
            <meta property="article:section" content={meta.article.section} />
          ) : null}
        </>
      ) : null}

      {/* Twitter Card */}
      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={meta.title} />
      <meta name="twitter:description" content={meta.description} />
      <meta name="twitter:image" content={ogImage} />
      {site.twitter ? (
        <meta name="twitter:site" content={site.twitter} />
      ) : null}

      {/* JSON-LD */}
      {(meta.jsonLd ?? []).map((obj, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: raw(ldJson(obj)) as unknown as string }}
        />
      ))}

      <Analytics site={site} />
    </head>
  );
}

// GA4 / GTM / AdSense / CF Web Analytics — injected only when the corresponding
// env id is set (tech-spec §12). GTM noscript fallback is rendered in the Layout
// body.
function Analytics({ site }: { site: SiteConfig }) {
  return (
    <>
      {site.gtmId ? (
        <script
          dangerouslySetInnerHTML={{
            __html: raw(
              `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${site.gtmId}');`,
            ) as unknown as string,
          }}
        />
      ) : null}
      {site.ga4Id ? (
        <>
          <script
            async
            src={`https://www.googletagmanager.com/gtag/js?id=${site.ga4Id}`}
          />
          <script
            dangerouslySetInnerHTML={{
              __html: raw(
                `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${site.ga4Id}');`,
              ) as unknown as string,
            }}
          />
        </>
      ) : null}
      {site.adsensePublisherId ? (
        <script
          async
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${site.adsensePublisherId}`}
          crossorigin="anonymous"
        />
      ) : null}
      {site.cfBeaconToken ? (
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon={`{"token": "${site.cfBeaconToken}"}`}
        />
      ) : null}
    </>
  );
}
