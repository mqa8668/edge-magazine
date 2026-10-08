// Structural fixture for the built-in safety blacklist: the taxonomy groups that
// must exist and the severity of each. Term-level changes are deliberate edits to
// src/pipeline/safety.ts plus a sentence in the false-positive corpus; a change
// HERE means a whole group was added, removed, or re-tiered.
//
// Do NOT edit this to make a test pass: a diff here is a real policy change.

import type { Severity } from "../../src/pipeline/safety";

export const EXPECTED_GROUPS: Record<string, Severity> = {
  sexual: "hard",
  politics: "hard",
  religion: "hard",
  illegal: "hard",
  hate: "hard",
  self_harm: "hard",
  violence_extreme: "hard",
  medical_claim: "hard",
  guarantee_claim: "hard",
  financial_claim: "hard",
  violence: "soft",
  profanity: "soft",
};
