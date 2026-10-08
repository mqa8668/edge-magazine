// The false-positive corpus. The gate must never refuse to publish ordinary prose
// just because a blacklisted string appears inside a benign word or inside a
// sentence that DENIES the thing the term names. Every blocked benign sentence is
// an article that dies and a publishing slot that is lost.
//
// Two classes of collision are pinned here:
//   1. substring collisions ("grape" vs "rape", "Shiitake" vs "shit") - fixed by
//      word-boundary matching;
//   2. debunking sentences ("there is no miracle cure for insomnia", "beware of
//      get-rich-quick schemes") - fixed by listing only the CLAIM shape, never
//      the bare vocabulary.
//
// This corpus is the regression net. Adding a blacklist term without running it
// past these sentences is how the gate ends up blocking ordinary prose again.
import { describe, expect, test } from "vitest";
import { checkSafety, hasHardHit } from "../src/pipeline/safety";

// Realistic prose for a general-interest magazine (productivity, wellness,
// habits, money, sleep, mindfulness, fitness, food, learning). Each entry names
// the term it could trip.
const BENIGN: [string, string][] = [
  ["Grape juice before bed is mostly sugar, so swap it for water.", "rape"],
  ["Rapeseed oil is a good source of omega-3 for everyday cooking.", "rape"],
  ["Shiitake mushrooms add depth to a quick weeknight dinner.", "shit"],
  ["A weekend trip to Scunthorpe still counts as a real break.", "substring"],
  ["Assassin's Creed marathons are not a sleep strategy.", "ass"],
  ["A cocktail of caffeine and late screens wrecks your sleep.", "cock"],
  ["Garden hoes are surprisingly good for a light morning workout.", "hoe"],
  ["Use the kill switch on notifications after nine at night.", "kill (idiom)"],
  ["Stop killing time on your phone during the commute.", "kill (idiom)"],
  ["You are killing it with that morning routine.", "kill (idiom)"],
  ["Kill two birds with one stone by walking to the meeting.", "kill (idiom)"],
  ["Don't torture yourself over one missed workout.", "torture (idiom)"],
  ["There is no miracle cure for poor sleep, only steady habits.", "miracle cure"],
  ["No supplement cures insomnia on its own.", "cures"],
  ["No herb cures cancer, which is why screening matters.", "cures cancer"],
  ["Researchers are working toward a cure for diabetes.", "cure diabetes"],
  ["Nobody can promise guaranteed results from a single habit.", "guaranteed results"],
  ["Be wary of get-rich-quick schemes that promise easy money.", "get rich quick"],
  ["Nobody offers guaranteed returns on honest investments.", "guaranteed returns"],
  ["True financial freedom starts with a small emergency fund.", "financial freedom"],
  ["There are no guarantees in habit formation, only odds.", "guarantee"],
  ["Suicide prevention hotlines are staffed around the clock.", "suicide"],
  ["Thoughts of suicide deserve to be heard, not judged.", "suicide"],
  ["This article covers suicide prevention and how to find support.", "suicide"],
  ["End your day with a ten-minute walk and a glass of water.", "end your life"],
  ["Hang your keys by the door so you never search for them.", "hang yourself"],
  ["Cut-throat competition at work raises stress for everyone.", "cut throat"],
  ["The gamble of skipping breakfast rarely pays off.", "gambling"],
  ["Drug interactions with grapefruit are worth asking a pharmacist about.", "drug"],
  ["Addictive games should come with a time limit.", "addictive"],
  ["The secret weapon of early risers is a laid-out outfit.", "weapon"],
  ["Mass transit commutes are a great time to read.", "mass murder"],
  ["Protest movements have shaped how we think about rest and labor.", "protest"],
  ["Government agencies also recommend walking more.", "government"],
  ["Overthrowing your own bad habits takes patience, not force.", "overthrow"],
  ["Treatment of anxiety often starts with sleep and routine.", "treason"],
  ["Religious holidays are a natural time to rest and reflect.", "religion"],
  ["Meditation and spirituality are part of many people's routines.", "religion"],
  ["Racism and discrimination at work are real stressors.", "hate"],
  ["Horror movie night can be a fun way to spend time with friends.", "horror (idiom)"],
  ["He was dead tired after the long shift and slept nine hours.", "dead"],
  ["Her blood pressure dropped after a month of daily walks.", "blood"],
  ["Low blood sugar can make anyone cranky before lunch.", "blood"],
  ["Abuse awareness training helps teams speak up early.", "abuse"],
  ["Damn, that was a long week; time to rest.", "damn"],
];

describe("no false positives on benign prose", () => {
  test.each(BENIGN)("%s", (sentence) => {
    const r = checkSafety(sentence);
    const hits = [...r.hardHits, ...r.softHits].map((h) => `${h.term} [${h.group}]`);
    expect({ sentence, hits, ok: r.ok }).toEqual({ sentence, hits: [], ok: true });
  });

  test("none of them are a HARD ideation-stage drop either", () => {
    for (const [s] of BENIGN) expect({ s, hard: hasHardHit(s) }).toEqual({ s, hard: false });
  });
});

// The other half of the trade: the claim-shaped terms must still fire on the real
// thing.
const MALICIOUS: [string, string][] = [
  ["The post calls to overthrow the government and incite riots.", "politics"],
  ["Groups spreading sedition online.", "politics"],
  ["How to run drug trafficking routes without getting caught.", "illegal"],
  ["Our sports betting picks win big every weekend.", "illegal"],
  ["Where to buy illegal drugs with no questions asked.", "illegal"],
  ["Explicit video and adult film sites ranked.", "sexual"],
  ["A guide on how to commit suicide painlessly.", "self_harm"],
  ["This leaf cures cancer completely, doctors say.", "medical_claim"],
  ["Miracle tea that heals all diseases overnight.", "medical_claim"],
  ["This tea is a miracle cure for insomnia.", "medical_claim"],
  ["This pill is guaranteed to cure arthritis.", "guarantee_claim"],
  ["Invest now for guaranteed high returns every month.", "financial_claim"],
  ["Double your money in 30 days with this trick.", "financial_claim"],
  ["A history of ethnic cleansing and incite hatred campaigns.", "hate"],
  ["Footage of a public execution and a beheading.", "violence_extreme"],
];

describe("real threats are still blocked", () => {
  test.each(MALICIOUS)("%s", (sentence, group) => {
    const r = checkSafety(sentence);
    expect({ sentence, blocked: !r.ok, group: r.hardHits[0]?.group }).toEqual({
      sentence,
      blocked: true,
      group,
    });
  });
});

describe("the word-boundary rule, stated explicitly", () => {
  test("a term inside a longer word never matches", () => {
    expect(checkSafety("grapefruit and rapeseed").ok).toBe(true);
    expect(checkSafety("a violent rape scene").ok).toBe(false);
  });

  test("inflection needs its own entry (plural is not a prefix match)", () => {
    // "kill" and "killing" are listed; "killer" is not and must not match.
    expect(checkSafety("A killer playlist for the gym").softHits).toEqual([]);
  });
});
