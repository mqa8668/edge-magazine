// Small HTML/text utilities shared across views and feeds.

const ENTITY_RE = /[&<>"']/g;
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Escape for use in attribute/text contexts (and XML — same five entities).
export function escapeHtml(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(ENTITY_RE, (ch) => ENTITIES[ch]);
}

// Strip tags to plain text (for meta descriptions, FTS body, RSS fallback).
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Truncate on a word boundary with an ellipsis (meta descriptions ~160 chars).
export function truncate(text: string, max = 160): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd() + "...";
}

// Reading time (~200 wpm) — used when the projection didn't supply one.
export function readingTimeFromText(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
