// Topic normalization for de-duplication.
//
// A topic string is folded to a canonical fingerprint so that reworded or
// reordered variants collapse together:
//   "The Pomodoro technique for procrastinators"
//   "Pomodoro: a technique procrastinators swear by"
// both reduce to a small content-token set. Two layers use it:
//   1. `key` (sorted unique tokens, hyphen-joined) -> exact/reordered dupes,
//      enforced by the UNIQUE column content_queue.norm_key.
//   2. `tokens` (a Set) -> near-dupes via Jaccard overlap in code.
//
// Folding reuses slugify (NFD diacritic strip + lowercase), so "Cafe" and
// "Café" fold identically.

import { slugify } from "../lib/slug";

// Function words with no topical value (stored in post-slugify ASCII form).
// Kept deliberately conservative: only clear grammatical glue, never content
// nouns/verbs.
const STOPWORDS = new Set<string>([
  "the", "an", "of", "for", "to", "in", "on", "and", "or", "with", "your",
  "you", "how", "why", "what", "is", "are", "be", "at", "by", "as", "it",
  "this", "that", "from", "can", "do", "does", "will", "about", "into", "our",
  "we", "my", "when", "while", "i",
]);

export interface NormalizedTopic {
  key: string; // canonical dedup key (sorted unique content tokens)
  tokens: Set<string>; // content tokens for similarity scoring
}

// Fold a topic/title to its content-token fingerprint.
export function normalizeTopic(text: string | null | undefined): NormalizedTopic {
  const raw = slugify(text, 200); // -> "the-pomodoro-technique-for-procrastinators"
  const tokens = new Set<string>();
  for (const tok of raw.split("-")) {
    if (!tok) continue;
    if (STOPWORDS.has(tok)) continue;
    if (tok.length === 1 && !/[0-9]/.test(tok)) continue; // drop stray single letters
    tokens.add(tok);
  }
  const key = [...tokens].sort().join("-");
  return { key, tokens };
}

// Jaccard overlap of two token sets: |A n B| / |A u B|, in [0, 1].
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Containment: share of a's tokens found in b, in [0, 1]. Asymmetric on
// purpose - it answers "is this short query already covered by that longer
// title?", where Jaccard stays low merely because b is bigger.
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / a.size;
}

// Default near-duplicate threshold: >= 50% token overlap is "too similar". Lowered
// from 0.6 after a dense backfill showed reworded near-dupes slipping through.
export const SIMILARITY_THRESHOLD = 0.5;

// A prior topic/title in the dedup ledger: its token set + a human label (the
// post title or queued topic) so a match can say WHAT it collided with.
export interface Prior {
  tokens: Set<string>;
  label: string;
}

// Is `candidate` a duplicate of anything already covered? Exact key match OR a
// token overlap at/above `threshold` with any prior topic. `priorKeys` maps each
// canonical key -> its label (for exact hits); `priors` carries token sets +
// labels (for near hits). `matched` is the colliding prior's label, when known.
export function isDuplicate(
  candidate: NormalizedTopic,
  priorKeys: Map<string, string>,
  priors: Prior[],
  threshold = SIMILARITY_THRESHOLD,
): { duplicate: boolean; reason?: string; score?: number; matched?: string } {
  if (!candidate.key) return { duplicate: true, reason: "empty-after-normalize" };
  const exact = priorKeys.get(candidate.key);
  if (exact !== undefined) {
    return { duplicate: true, reason: "exact-key", matched: exact };
  }
  let best = 0;
  let bestLabel: string | undefined;
  for (const prior of priors) {
    const s = jaccard(candidate.tokens, prior.tokens);
    if (s > best) {
      best = s;
      bestLabel = prior.label;
    }
    if (best >= threshold) {
      return { duplicate: true, reason: "similar", score: round2(best), matched: bestLabel };
    }
  }
  return { duplicate: false, score: round2(best) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
