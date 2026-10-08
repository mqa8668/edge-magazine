// JSON-LD builders (port of legacy SEO.StructuredData). Each returns a plain
// object serialized into a <script type="application/ld+json"> by the Head
// component. Shapes match the SEO parity contract (tech-spec §12).

import type { SiteConfig } from "../lib/config";

type Json = Record<string, unknown>;

export interface BreadcrumbItem {
  name: string;
  url: string;
}

export interface ListItemInput {
  url: string;
  name: string;
  description?: string | null;
}

const CONTEXT = "https://schema.org";

export function organization(site: SiteConfig): Json {
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    name: site.name,
    url: site.url,
    logo: site.logoUrl,
  };
}

export function website(site: SiteConfig): Json {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    name: site.name,
    url: site.url,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${site.url}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function breadcrumb(items: BreadcrumbItem[]): Json {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

function itemList(items: ListItemInput[]): Json {
  return {
    "@type": "ItemList",
    itemListElement: items.map((it, i) => {
      const el: Json = {
        "@type": "ListItem",
        position: i + 1,
        url: it.url,
        name: it.name,
      };
      if (it.description) el.description = it.description;
      return el;
    }),
  };
}

export interface ArticleInput {
  headline: string;
  description?: string | null;
  imageUrl?: string | null;
  url: string;
  datePublished: string;
  dateModified?: string | null;
  authorName?: string | null;
  authorUrl?: string | null;
}

export function article(site: SiteConfig, a: ArticleInput): Json {
  const node: Json = {
    "@context": CONTEXT,
    "@type": "Article",
    headline: a.headline,
    datePublished: a.datePublished,
    dateModified: a.dateModified || a.datePublished,
    mainEntityOfPage: { "@type": "WebPage", "@id": a.url },
    publisher: {
      "@type": "Organization",
      name: site.name,
      logo: { "@type": "ImageObject", url: site.logoUrl },
    },
  };
  if (a.imageUrl) node.image = [a.imageUrl];
  if (a.description) node.description = a.description;
  if (a.authorName) {
    node.author = {
      "@type": "Person",
      name: a.authorName,
      ...(a.authorUrl ? { url: a.authorUrl } : {}),
    };
  }
  return node;
}

// FAQPage (schema.org/FAQPage). Note: since Google's Aug-2023 change, FAQ rich
// results render only for authoritative gov/health sites, so this is emitted for
// entity/graph value - the visible on-page FAQ (appended to the article body) is
// where the long-tail / People-Also-Ask traffic actually comes from.
export function faqPage(items: { question: string; answer: string }[]): Json {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer },
    })),
  };
}

export function collectionPage(input: {
  name: string;
  description?: string | null;
  url: string;
  items: ListItemInput[];
}): Json {
  const node: Json = {
    "@context": CONTEXT,
    "@type": "CollectionPage",
    name: input.name,
    url: input.url,
    mainEntity: itemList(input.items),
  };
  if (input.description) node.description = input.description;
  return node;
}

export function personPage(input: {
  name: string;
  description?: string | null;
  url: string;
  imageUrl?: string | null;
  items: ListItemInput[];
}): Json {
  const person: Json = {
    "@context": CONTEXT,
    "@type": "Person",
    name: input.name,
    url: input.url,
  };
  if (input.description) person.description = input.description;
  if (input.imageUrl) person.image = input.imageUrl;
  return {
    "@context": CONTEXT,
    "@type": "ProfilePage",
    mainEntity: person,
    hasPart: itemList(input.items),
  };
}
