// Optional stock photos for post covers (never AI-generated). The provider is
// Pexels and is only used when a PEXELS_API_KEY secret is set; with no key this
// returns null and the post simply gets no third-party image (the cover is left
// for the generated placeholder). Returns a landscape photo the pipeline
// downloads and uploads to R2, found with a short English/visual query.

import type { Bindings } from "../env";
import { log } from "../lib/log";
import { getConfig } from "../lib/runtime-config";

export interface StockPhoto {
  provider: "pexels";
  id: string; // globally-unique dedup id, e.g. "pexels-12345"
  downloadUrl: string; // direct URL to fetch the image bytes
  width: number;
  height: number;
  alt: string;
  creditName: string;
  creditUrl: string;
}

const MIN_WIDTH = 1200;

// Photo API / CDN calls have NO business hanging the pipeline: it runs inside a
// Worker request/waitUntil budget, and a stalled image download used to leave a
// run stuck in 'running' forever. Bound every fetch with an abort timeout.
const API_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`timeout after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Find one usable landscape photo, skipping any id already used on another post.
export async function fetchPhoto(
  env: Bindings,
  opts: { query: string; usedIds?: Set<string> },
): Promise<StockPhoto | null> {
  const used = opts.usedIds ?? new Set<string>();
  const query = opts.query.trim();
  if (!query) return null;

  // Provider order is an ops knob (photos.providerOrder in runtime config).
  const order = (await getConfig(env)).photos.providerOrder;
  const errors: string[] = [];
  for (const name of order) {
    if (name === "pexels" && env.PEXELS_API_KEY) {
      try {
        const p = await pexels(env.PEXELS_API_KEY, query, used);
        if (p) return p;
      } catch (e) {
        errors.push(`pexels: ${msg(e)}`);
      }
    }
  }
  if (errors.length) log.warn("photo.fetch_failed", { query, errors: errors.join(" | ") });
  return null;
}

async function pexels(
  apiKey: string,
  query: string,
  used: Set<string>,
): Promise<StockPhoto | null> {
  const url =
    "https://api.pexels.com/v1/search?orientation=landscape&size=large&per_page=30&query=" +
    encodeURIComponent(query);
  const res = await fetchTimeout(url, { headers: { authorization: apiKey } }, API_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  for (const p of data.photos ?? []) {
    const id = `pexels-${p.id}`;
    if (used.has(id)) continue;
    if ((p.width ?? 0) < MIN_WIDTH) continue;
    const downloadUrl = p.src?.large2x || p.src?.original || p.src?.landscape;
    if (!downloadUrl) continue;
    return {
      provider: "pexels",
      id,
      downloadUrl,
      width: p.width,
      height: p.height,
      alt: (p.alt || query).trim(),
      creditName: p.photographer ?? "Pexels",
      creditUrl: p.url ?? "https://www.pexels.com",
    };
  }
  return null;
}

// Fetch the image bytes for a chosen photo.
export async function downloadImage(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetchTimeout(url, {}, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("download: empty body");
  return { bytes, contentType };
}

// Map a content-type to a file extension for the R2 key.
export function extForContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("avif")) return "avif";
  return "jpg";
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url?: string;
  alt?: string;
  photographer?: string;
  src?: {
    original?: string;
    large2x?: string;
    large?: string;
    landscape?: string;
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
