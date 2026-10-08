// Content-rule guard. Scans editorial content (the dev seed) for "AI-tell"
// glyphs and emoji that the project rule forbids (see AGENTS.md and
// src/lib/sanitize.ts). Exits non-zero on any hit so it can gate CI / commits.
//   node scripts/check-content.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same banned set as src/lib/sanitize.ts (glyphs + emoji ranges).
const GLYPHS =
  "→←↔⇒⇐—–‒‑−•·⁃▪●◦…“”„‟«»‘’‚‛′″×∕⁄≥≤≈≠±​‍﻿█▓▒░▸▶◀‣™";
const GLYPH_RE = new RegExp(`[${GLYPHS}]`, "gu");
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/gu;

// Files holding editorial content. (Source/templates are exempt.)
const TARGETS = ["seed/sample.sql"];

let failures = 0;
for (const rel of TARGETS) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const hits = new Set();
    for (const m of line.matchAll(GLYPH_RE)) hits.add(m[0]);
    for (const m of line.matchAll(EMOJI_RE)) hits.add(m[0]);
    if (hits.size) {
      failures++;
      const glyphs = [...hits]
        .map((g) => `U+${g.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
        .join(" ");
      console.error(`${rel}:${i + 1}  forbidden glyph(s): ${glyphs}`);
    }
  });
}

if (failures) {
  console.error(`\nContent rule FAILED: ${failures} line(s) contain AI-tell glyphs.`);
  console.error("Fix the content (straight quotes, hyphens, ascii, no emoji) or run it through src/lib/sanitize.ts.");
  process.exit(1);
}
console.log("Content rule passed: no AI-tell glyphs found.");
