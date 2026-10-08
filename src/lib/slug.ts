// Vietnamese-safe slugify: strip diacritics to ASCII, map dj, lowercase, and
// collapse everything else to single hyphens. Produces "khong dau" slugs, e.g.
// "Ngu du giac khong can 8 tieng" -> "ngu-du-giac-khong-can-8-tieng".
export function slugify(input: string | null | undefined, max = 80): string {
  if (!input) return "";
  const full = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics
    .replace(/[đ]/g, "d") // Vietnamese d with stroke (lowercase)
    .replace(/[Đ]/g, "D") // Vietnamese D with stroke (uppercase)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= max) return full;
  // Truncate on a word boundary. A blind slice(0, max) can cut a token in half
  // ("...la-khoi-dau" -> "...la-khoi-d"); if the char at the cut is mid-token
  // (not a hyphen), drop the partial trailing token back to the last hyphen.
  let cut = full.slice(0, max);
  if (full[max] !== "-") {
    const lastDash = cut.lastIndexOf("-");
    if (lastDash > 0) cut = cut.slice(0, lastDash);
  }
  return cut.replace(/-+$/g, "");
}

// A well-formed stored slug: lowercase ascii words joined by single hyphens.
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// Diacritic-folded lowercase text with spaces preserved (for phrase matching,
// e.g. banned-opener detection). Accented and unaccented spellings (e.g.
// Vietnamese "thoi dai" and "thời đại") fold the same, so ASCII rule lists
// still catch accented prose.
export function foldAscii(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đ]/g, "d")
    .replace(/[Đ]/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Same normalization as foldAscii (lowercase, punctuation -> single spaces) but
// KEEPING the diacritics. The accent-sensitive half of phrase matching: a rule
// term whose folded form collides with a benign word (Vietnamese "phản động"
// folds onto "phần đông") has to be matched on this instead, or
// the gate fires on ordinary prose. See safety.ts ACCENT_SENSITIVE.
export function normalizeVi(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
