import type { Bindings } from "../env";

// Per-request site config derived from env vars. Centralizes constants used by
// SEO (canonical/OG), nav, and feeds so every page type emits identical values.
export interface SiteConfig {
  url: string; // origin, no trailing slash, e.g. https://example.com
  name: string;
  tagline: string;
  contactEmail: string; // empty = hide contact blocks
  description: string;
  locale: string; // OG locale, e.g. en_US
  language: string; // RSS <language>, e.g. en-us
  twitter: string; // @handle (empty string if none)
  logoUrl: string; // absolute — Organization logo / fallback OG image
  defaultOgImage: string; // absolute — OG fallback for listing pages
  ga4Id: string;
  gtmId: string;
  adsensePublisherId: string;
  cfBeaconToken: string; // Cloudflare Web Analytics beacon (empty = no beacon)
  themeColor: string;
}

const TAGLINE = "Independent stories, edge-fast";
// Fuller homepage meta/OG description (the tagline alone is too short for SEO).
const SITE_DESCRIPTION =
  "An independent online magazine with evidence-based writing, published at the edge.";

export function siteConfig(env: Bindings, origin = ""): SiteConfig {
  const url = (env.SITE_URL || origin || "http://localhost:8787").replace(/\/+$/, "");
  return {
    url,
    name: env.SITE_NAME || "Edge Magazine",
    contactEmail: (env.CONTACT_EMAIL || "").trim(),
    tagline: TAGLINE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
    language: "en-us",
    twitter: "",
    logoUrl: url + "/icon-512.svg",
    // Raster fallback OG card. Social platforms do NOT render SVG og:image,
    // so this MUST stay a real PNG (see scripts/gen-og.mjs / `npm run gen:og`).
    defaultOgImage: url + "/og-default.png",
    ga4Id: env.GA4_ID || "",
    gtmId: env.GTM_ID || "",
    adsensePublisherId: env.ADSENSE_PUBLISHER_ID || "",
    cfBeaconToken: env.CF_BEACON_TOKEN || "",
    themeColor: "#111111",
  };
}

// Absolute URL builder from a path. Guarantees a single leading slash.
export function absUrl(site: SiteConfig, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return site.url + "/" + path.replace(/^\/+/, "");
}

// Canonical URLs (mirror tech-spec §6 route map).
export const routes = {
  home: () => "/",
  category: (slug: string) => `/${slug}`,
  post: (categorySlug: string, postSlug: string) =>
    `/${categorySlug}/${postSlug}`,
  tag: (slug: string) => `/tags/${slug}`,
  author: (slug: string) => `/authors/${slug}`,
  cluster: (slug: string) => `/clusters/${slug}`,
  clusters: () => "/clusters",
  search: () => "/search",
  newsletter: () => "/newsletter",
};
