// R2 image helpers. Posts reference images by R2 key (tech-spec §8); they are
// served at /uploads/* from the R2 bucket. Inline images in processed_html
// already use /uploads/... paths.

// R2 key → public path. Keys are stored without a leading slash.
export function uploadPath(key: string | null | undefined): string | null {
  if (!key) return null;
  const clean = key.replace(/^\/+/, "");
  // Inline html may already store a full /uploads/... path.
  if (clean.startsWith("uploads/")) return "/" + clean;
  return "/uploads/" + clean;
}

// A 1×1 transparent-ish placeholder when there is no blurhash. The pipeline
// stores a precomputed blurhash; rendering the actual blur is a Phase 3 nicety.
// For now we expose the focal point so CSS object-position avoids layout shift.
export function focalObjectPosition(
  x: number | null | undefined,
  y: number | null | undefined,
): string {
  const fx = clamp01(x ?? 0.5) * 100;
  const fy = clamp01(y ?? 0.5) * 100;
  return `${fx.toFixed(1)}% ${fy.toFixed(1)}%`;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// Content-hashed image keys are immutable → cache for a year (tech-spec §8).
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
