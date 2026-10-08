// Date formatting. Stored values are ISO-8601 TEXT (tech-spec §5).

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Human display in English, e.g. "June 30, 2026". Formatted by hand in UTC so
// output is deterministic regardless of the runtime's ICU data. Machine formats
// below (sitemap/RSS/OG) are UTC as well.
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDisplay(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ISO-8601 (sitemap <lastmod>, OG article:published_time/modified_time).
export function formatIso(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toISOString() : "";
}

// Date-only ISO (W3C sitemap lastmod / news publication_date variants).
export function formatIsoDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toISOString().slice(0, 10) : "";
}

// RFC-822 for RSS <pubDate>, e.g. "Tue, 30 Jun 2026 12:00:00 GMT".
export function formatRfc822(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toUTCString() : "";
}

// Hours since a timestamp (news sitemap = last 48h).
export function hoursSince(iso: string | null | undefined, now: Date): number {
  const d = parse(iso);
  if (!d) return Infinity;
  return (now.getTime() - d.getTime()) / 3_600_000;
}
