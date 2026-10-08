// Generates deterministic SVG placeholder covers (gradient + geometric shapes
// derived from a hash of the slug). No photos, no text.
//   node scripts/gen-covers.mjs                 -> seed/uploads/posts/<slug>/cover.svg
// Then upload with: node scripts/upload-r2.mjs [--remote]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SLUGS = [
  "building-habits-that-last",
  "a-practical-guide-to-deep-work",
  "a-calmer-evening-routine",
  "plan-your-week-in-thirty-minutes",
  "note-taking-that-you-reuse",
  "a-gentle-start-to-digital-minimalism",
];

// FNV-1a 32-bit, then a small PRNG (mulberry32) so every value is reproducible.
function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1600;
const H = 900;

export function coverSvg(slug) {
  const rand = rng(hash(slug));
  const hue = Math.floor(rand() * 360);
  const hue2 = (hue + 40 + Math.floor(rand() * 80)) % 360;
  const angle = Math.floor(rand() * 360);
  const c1 = `hsl(${hue} 55% 38%)`;
  const c2 = `hsl(${hue2} 60% 62%)`;
  const light = `hsl(${hue2} 70% 88%)`;

  const shapes = [];
  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rand() * 3);
    const x = Math.round(rand() * W);
    const y = Math.round(rand() * H);
    const s = Math.round(120 + rand() * 360);
    const op = (0.12 + rand() * 0.28).toFixed(2);
    const fill = rand() > 0.5 ? "#ffffff" : light;
    if (kind === 0) {
      shapes.push(`<circle cx="${x}" cy="${y}" r="${s / 2}" fill="${fill}" fill-opacity="${op}"/>`);
    } else if (kind === 1) {
      const r = Math.round(rand() * 360);
      shapes.push(`<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" rx="${Math.round(s * 0.12)}" fill="${fill}" fill-opacity="${op}" transform="rotate(${r} ${x} ${y})"/>`);
    } else {
      const r = Math.round(rand() * 360);
      const p = [[0, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]
        .map(([px, py]) => `${Math.round(x + px)},${Math.round(y + py)}`)
        .join(" ");
      shapes.push(`<polygon points="${p}" fill="${fill}" fill-opacity="${op}" transform="rotate(${r} ${x} ${y})"/>`);
    }
  }
  // One thin ring and a baseline band for an editorial feel.
  const rx = Math.round(W * (0.3 + rand() * 0.4));
  const ry = Math.round(H * (0.3 + rand() * 0.4));
  shapes.push(`<circle cx="${rx}" cy="${ry}" r="${Math.round(160 + rand() * 120)}" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="6"/>`);
  shapes.push(`<rect x="0" y="${H - 36}" width="${W}" height="36" fill="#000000" fill-opacity="0.18"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Abstract placeholder cover">
<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
${shapes.join("\n")}
</svg>
`;
}

// Slugs come from the CLI (extra args) or the default sample set above.
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : SLUGS;
for (const slug of slugs) {
  const out = join(ROOT, "seed", "uploads", "posts", slug, "cover.svg");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, coverSvg(slug));
  console.log(`  wrote seed/uploads/posts/${slug}/cover.svg`);
}
