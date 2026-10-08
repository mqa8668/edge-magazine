// Deterministic category + style rotation. The point is variety: the site must
// not read one-note, so which category, author voice, copywriting formula,
// article shape, and length each article uses is decided by a rotating counter -
// never by the LLM. Given the same inputs this is fully reproducible.
//
// Personas, their preferred formulas/types and their category fit come from the
// active niche pack (src/pipeline/niche.ts). Any persona CAN write any category;
// affinity just biases toward a natural fit.

import { niche } from "./niche";

export interface Persona {
  slug: string;
  // Preferred copywriting formulas (keys of the niche pack's `formulas`).
  formulas: string[];
  // Preferred article shapes.
  types: string[];
}

export const PERSONAS: Record<string, Persona> = Object.fromEntries(
  niche.personas.map((p) => [p.slug, { slug: p.slug, formulas: p.formulas, types: p.types }]),
);

// Which personas fit each category best (rotated among within a category).
const CATEGORY_PERSONAS: Record<string, string[]> = {};
for (const p of niche.personas) {
  for (const c of p.categories) (CATEGORY_PERSONAS[c] ??= []).push(p.slug);
}

// Length buckets (word targets). Weighted toward medium by ordering + rotation.
// Targets kept realistic to how much the model actually writes (~600-1000 words);
// an over-ambitious "long" (1900) just failed the length gate repeatedly.
const LENGTHS = [
  { bucket: "medium", words: 1300 },
  { bucket: "short", words: 1050 },
  { bucket: "long", words: 1500 },
  { bucket: "medium", words: 1250 },
];

export interface StyleAssignment {
  categorySlug: string;
  personaSlug: string;
  formula: string;
  articleType: string;
  targetWords: number;
  lengthBucket: string;
}

// Decide the full style for the i-th article in a category. Independent strides
// per axis keep combinations from repeating in lock-step.
export function planStyle(i: number, categorySlug: string): StyleAssignment {
  const cands = CATEGORY_PERSONAS[categorySlug] ?? Object.keys(PERSONAS);
  const personaSlug = cands[i % cands.length];
  const p = PERSONAS[personaSlug];
  // Advance the formula only once we have cycled the personas, so a category
  // sees persona A/formula X, persona B/formula X, persona A/formula Y, ...
  const formula = p.formulas[Math.floor(i / cands.length) % p.formulas.length];
  const articleType = p.types[i % p.types.length];
  const len = LENGTHS[i % LENGTHS.length];
  return {
    categorySlug,
    personaSlug,
    formula,
    articleType,
    targetWords: len.words,
    lengthBucket: len.bucket,
  };
}

// Pick the least-covered category (ties broken by the given order).
export function leastCoveredCategory(
  coverage: Record<string, number>,
  categories: string[],
): string {
  let best = categories[0];
  for (const c of categories) {
    if ((coverage[c] ?? 0) < (coverage[best] ?? 0)) best = c;
  }
  return best;
}

// Plan a batch of `count` articles: balance categories (fill the least-covered
// first) and rotate style off a global counter so successive runs stay varied.
// Stagger each category's rotation phase (prime, coprime with the axis periods)
// so that the FIRST article of every category is not the same persona/formula.
const PHASE_STRIDE = 7;

export function planBatch(opts: {
  categories: string[];
  coverage: Record<string, number>;
  count: number;
  startIndex?: number;
}): StyleAssignment[] {
  const cov: Record<string, number> = {};
  for (const c of opts.categories) cov[c] = opts.coverage[c] ?? 0;
  // Per-category style index: a fixed per-category phase offset + how many that
  // category already has, so categories rotate their own staggered sequences.
  const perCat: Record<string, number> = {};
  opts.categories.forEach((c, idx) => {
    perCat[c] = (opts.startIndex ?? 0) + idx * PHASE_STRIDE + cov[c];
  });

  const out: StyleAssignment[] = [];
  for (let k = 0; k < opts.count; k++) {
    const cat = leastCoveredCategory(cov, opts.categories);
    out.push(planStyle(perCat[cat], cat));
    cov[cat]++;
    perCat[cat]++;
  }
  return out;
}
