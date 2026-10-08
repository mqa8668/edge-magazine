// Generates the default Open Graph image (1200x630) from the site name.
// Writes public/og-default.svg and public/og-default.png. Text uses the
// machine's system fonts (serif fallback); resvg-js is a devDependency only.
//   SITE_NAME="My Site" node scripts/gen-og.mjs        (default "Edge Magazine")
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_NAME = (process.env.SITE_NAME || "Edge Magazine").trim();
const INITIAL = ([...SITE_NAME][0] || "E").toUpperCase();
const PAPER = "#f8f8f6";
const INK = "#111111";
const ACCENT = "#d9291b";
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const W = 1200;
const H = 630;

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ogDefaultSvg() {
  const mark = 128;
  const wordFont = SITE_NAME.length > 18 ? 72 : 104;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  <rect x="0" y="0" width="${W}" height="12" fill="${ACCENT}"/>
  <g transform="translate(80 251) scale(${mark / 100})">
    <rect width="100" height="100" rx="22" fill="${INK}"/>
    <text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="${SERIF}" font-size="68" font-weight="800" fill="${PAPER}">${esc(INITIAL)}</text>
    <circle cx="80" cy="80" r="6" fill="${ACCENT}"/>
  </g>
  <text x="240" y="${315 + wordFont * 0.12}" font-family="${SERIF}" font-size="${wordFont}" font-weight="800" fill="${INK}" letter-spacing="-2">${esc(SITE_NAME)}</text>
</svg>`;
}

function main() {
  const svg = ogDefaultSvg();
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    background: PAPER,
    font: { loadSystemFonts: true, defaultFontFamily: "Georgia" },
    shapeRendering: 2,
    textRendering: 2,
  })
    .render()
    .asPng();
  mkdirSync(join(ROOT, "public"), { recursive: true });
  writeFileSync(join(ROOT, "public", "og-default.svg"), svg);
  writeFileSync(join(ROOT, "public", "og-default.png"), png);
  console.log(`Wrote public/og-default.(svg|png) for "${SITE_NAME}" (${png.length} bytes).`);
}

main();
