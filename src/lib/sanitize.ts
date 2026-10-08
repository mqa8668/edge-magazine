// Content sanitizer — TypeScript port of the doc-builder sanitizer
// (~/.claude/skills/doc-builder/scripts/build_doc.py). It strips "AI-tell"
// typography and emoji so published prose reads like a human typed it on a
// keyboard: em/en dashes -> "-", smart quotes -> straight, ellipsis -> "...",
// arrows/bullets/box-glyphs -> ascii, pictographs removed. Professional and
// technical English (the words themselves) is left untouched.
//
// PROJECT RULE: all pipeline-produced content (post title/excerpt/body/meta,
// author bio, category/tag names) MUST pass through cleanText/cleanHtml before
// it is stored or rendered. Enforced by scripts/check-content.mjs.

// AI/Unicode punctuation -> what a person types on a keyboard.
const GLYPHS: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "⇐": "<=",
  "—": "-", "–": "-", "‒": "-", "‑": "-", "−": "-",
  "•": "-", "·": "-", "⁃": "-", "▪": "-", "●": "-", "◦": "-",
  "…": "...",
  "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"',
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "″": '"',
  "×": "x", "∕": "/", "⁄": "/",
  "≥": ">=", "≤": "<=", "≈": "~", "≠": "!=", "±": "+/-",
  // unusual spaces -> normal space; zero-width -> removed
  " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", " ": " ", "　": " ",
  "​": "", "‍": "", "﻿": "",
  // box drawing / block glyphs -> plain ascii
  "█": "#", "▓": "#", "▒": "=", "░": ".",
  "─": "-", "│": "|", "┄": "-", "┈": "-",
  "┌": "+", "┐": "+", "└": "+", "┘": "+",
  "├": "+", "┤": "+", "┬": "+", "┴": "+", "┼": "+",
  "▸": ">", "▶": ">", "◀": "<", "‣": ">",
  "™": "(tm)",
};

const GLYPH_RE = new RegExp(
  `[${Object.keys(GLYPHS)
    .map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("")}]`,
  "gu",
);

// Pictographs / dingbats / flags / variation selectors / ZWJ. Note: arrows and
// geometric shapes are deliberately NOT here — those are mapped by GLYPHS.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

function mapGlyphs(s: string): string {
  return s.replace(GLYPH_RE, (ch) => GLYPHS[ch] ?? ch);
}

// Plain-text sanitize: glyph map + emoji strip + tidy spacing.
export function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  let t = mapGlyphs(s).replace(EMOJI_RE, "");
  t = t.replace(/[ \t]{2,}/g, " "); // collapse runs of spaces
  t = t.replace(/ +([,.;:!?])/g, "$1"); // no space before punctuation
  return t.trim();
}

// HTML-safe sanitize: same glyph/emoji rules, but DON'T collapse whitespace
// (would corrupt <pre>/<code>) and don't touch tag/attribute syntax (the mapped
// glyphs never appear in ascii markup).
export function cleanHtml(s: string | null | undefined): string {
  if (!s) return "";
  return mapGlyphs(s).replace(EMOJI_RE, "");
}

// Detector used by the content-rule check script (returns matched glyphs).
export function findAiTell(s: string): string[] {
  const hits = new Set<string>();
  for (const m of s.matchAll(GLYPH_RE)) hits.add(m[0]);
  for (const m of s.matchAll(EMOJI_RE)) hits.add(m[0]);
  return [...hits];
}
