// Category accent colors (mirrors the Figma design's categoryColors map).
// Keyed by lowercase category/tag name; falls back to the ink color.
const COLORS: Record<string, string> = {
  productivity: "#2563eb", // blue-600
  wellness: "#059669", // emerald-600
  habits: "#7c3aed", // violet-600
  focus: "#d97706", // amber-600
  sleep: "#4f46e5", // indigo-600
  mindfulness: "#0d9488", // teal-600 (distinct from wellness)
  exercise: "#e11d48", // rose-600
  nutrition: "#65a30d", // lime-600
  journaling: "#0891b2", // cyan-600
  learning: "#c026d3", // fuchsia-600
  attention: "#d97706",
  motivation: "#7c3aed",
};

// Soft pill variant used on photo overlays (Figma categoryBg map: *-50 bg,
// *-700 text).
const PILLS: Record<string, { bg: string; fg: string }> = {
  productivity: { bg: "#eff6ff", fg: "#1d4ed8" }, // blue-50 / blue-700
  wellness: { bg: "#ecfdf5", fg: "#047857" }, // emerald-50 / emerald-700
  habits: { bg: "#f5f3ff", fg: "#6d28d9" }, // violet-50 / violet-700
  focus: { bg: "#fffbeb", fg: "#b45309" }, // amber-50 / amber-700
  sleep: { bg: "#eef2ff", fg: "#4338ca" }, // indigo-50 / indigo-700
  mindfulness: { bg: "#f0fdfa", fg: "#0f766e" }, // teal-50 / teal-700
  exercise: { bg: "#fff1f2", fg: "#be123c" }, // rose-50 / rose-700
  nutrition: { bg: "#f7fee7", fg: "#4d7c0f" }, // lime-50 / lime-700
  journaling: { bg: "#ecfeff", fg: "#0e7490" }, // cyan-50 / cyan-700
  learning: { bg: "#fdf4ff", fg: "#a21caf" }, // fuchsia-50 / fuchsia-700
};

// Solid banner/button color per category (Figma bgSolidMap: *-600, amber-500).
const SOLIDS: Record<string, string> = {
  productivity: "#2563eb", // blue-600
  wellness: "#059669", // emerald-600
  habits: "#7c3aed", // violet-600
  focus: "#f59e0b", // amber-500
  sleep: "#4f46e5", // indigo-600
  mindfulness: "#0d9488", // teal-600
  exercise: "#e11d48", // rose-600
  nutrition: "#65a30d", // lime-600
  journaling: "#0891b2", // cyan-600
  learning: "#c026d3", // fuchsia-600
};

export function categoryColor(name: string): string {
  return COLORS[name.trim().toLowerCase()] ?? "#111111";
}

export function categorySolid(name: string): string {
  return SOLIDS[name.trim().toLowerCase()] ?? "#111111";
}

export function categoryPill(name: string): { bg: string; fg: string } {
  return PILLS[name.trim().toLowerCase()] ?? { bg: "#f0f0ee", fg: "#111111" };
}
