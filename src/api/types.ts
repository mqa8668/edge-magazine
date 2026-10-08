// Publish Worker payload contract (tech-spec §15). The content pipeline (Phase 2
// Cron / orchestrator) sends this to POST /api/publish, or calls publishPost()
// directly on the edge. Every text field is sanitized (cleanText/cleanHtml)
// before it is written to D1 - the caller does not need to pre-sanitize.

// A binary asset to store verbatim in R2 at `key`. The pipeline decides keys and
// embeds their /uploads/... paths in bodyHtml (and coverImageKey).
export interface PublishImage {
  key: string; // R2 key, e.g. "uploads/posts/<slug>/cover.webp" (leading slash optional)
  contentType: string; // e.g. "image/webp"
  // Provide ONE of: base64 (HTTP callers) or raw bytes (in-process callers).
  dataBase64?: string; // base64 (a "data:...;base64," prefix is tolerated)
  bytes?: Uint8Array; // raw bytes (used by the in-process orchestrator)
}

// A tag reference. `slug` is derived from `name` (no diacritics) when omitted.
export interface PublishTag {
  name: string;
  slug?: string;
}

export interface PublishInput {
  // Identity + taxonomy
  slug: string; // stored post slug, no diacritics (validated)
  categorySlug: string; // must resolve to an existing category
  authorSlug?: string; // optional; must resolve when present
  tags?: (string | PublishTag)[];

  // Content
  title: string;
  excerpt?: string;
  bodyHtml: string; // -> processed_html (cleanHtml'd)

  // SEO / meta
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  schemaJson?: string; // JSON-LD string, stored as-is
  sourceDomain?: string;

  // Cover image (bytes go in `images`; these are the DB references)
  coverImageKey?: string;
  coverImageAlt?: string;
  coverFocalX?: number;
  coverFocalY?: number;
  coverBlurhash?: string;
  ogImageKey?: string;
  firstContentImageUrl?: string;

  // Flags + scheduling
  isFeatured?: boolean;
  isEvergreen?: boolean; // default true
  publishedAt?: string; // ISO-8601; default now. Backdate for the launch backfill.
  lastUpdatedAt?: string;

  // Optional overrides (else computed from bodyHtml)
  readingTime?: number;
  wordCount?: number;

  // Binary assets to upload to R2 before the row is written
  images?: PublishImage[];
}

export interface PublishResult {
  ok: true;
  id: number;
  slug: string;
  url: string; // canonical path, e.g. /focus/single-tasking
  created: boolean; // true = new post, false = updated existing slug
  imagesUploaded: number;
  purged: string[]; // page URLs evicted from the edge cache
}
