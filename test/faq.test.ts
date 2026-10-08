import { describe, expect, test } from "vitest";
import { filterFaq, parseFaq, renderFaqHtml } from "../src/pipeline/generate";
import { faqPage } from "../src/seo/structured-data";

describe("parseFaq", () => {
  test("keeps clean Q&A pairs, caps at 3", () => {
    const out = parseFaq([
      { q: "How many hours of sleep are enough?", a: "Adults need 7-9 hours a night." },
      { q: "Does coffee hurt your sleep?", a: "Yes, if you drink it after 2 p.m." },
      { q: "How long should a nap be?", a: "About 20 minutes is ideal." },
      { q: "A fourth question gets cut", a: "Because 3 entries is the cap." },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ q: "How many hours of sleep are enough?", a: "Adults need 7-9 hours a night." });
  });

  test("drops too-short question/answer and non-array input", () => {
    expect(parseFaq([{ q: "ok?", a: "too short" }])).toEqual([]); // q < 6 chars
    expect(parseFaq([{ q: "A full question?", a: "short" }])).toEqual([]); // a < 10 chars
    expect(parseFaq(undefined)).toEqual([]);
    expect(parseFaq("nope")).toEqual([]);
  });

  test("strips AI-tell glyphs via cleanText", () => {
    const out = parseFaq([{ q: "How do I focus for longer?", a: "Try the Pomodoro technique \u2014 25 minutes of work." }]);
    expect(out[0].a).not.toContain("\u2014"); // em dash normalized
    expect(out[0].a).toContain("-");
  });
});

describe("renderFaqHtml", () => {
  test("renders a visible section with whitelisted tags and escapes HTML", () => {
    const html = renderFaqHtml([{ q: "1 < 2 & 3 > 0?", a: "Correct." }]);
    expect(html).toContain("<h2>Frequently asked questions</h2>");
    expect(html).toContain("<h3>1 &lt; 2 &amp; 3 &gt; 0?</h3>");
    expect(html).toContain("<p>Correct.</p>");
    expect(html).not.toMatch(/<(details|summary|script)/);
  });
});

describe("faqPage JSON-LD", () => {
  test("emits a valid FAQPage with Question/acceptedAnswer nodes", () => {
    const node = faqPage([{ question: "How many hours of sleep?", answer: "7-9 hours." }]) as any;
    expect(node["@type"]).toBe("FAQPage");
    expect(node.mainEntity).toHaveLength(1);
    expect(node.mainEntity[0]).toMatchObject({
      "@type": "Question",
      name: "How many hours of sleep?",
      acceptedAnswer: { "@type": "Answer", text: "7-9 hours." },
    });
  });
});

describe("filterFaq", () => {
  const sentence2 = "Sleep debt builds up across many nights and can exhaust the body without you noticing it.";
  const body = [
    "<p>Enough sleep matters for memory and your ability to concentrate each day.</p>",
    "<h2>Why enough sleep still leaves you tired</h2>",
    `<p>${sentence2}</p>`,
    "<h2>How to repay sleep debt properly</h2>",
    "<p>Going to bed thirty minutes earlier for a week helps the body recover naturally.</p>",
  ].join("\n");

  test("drops an answer that restates a body sentence", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "What is sleep debt and is it risky?", a: sentence2 }],
      { bodyHtml: body },
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe("answer-restates-body");
  });

  test("drops a question that restates a heading", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "Why enough sleep still leaves you tired?", a: "Keep a sleep diary for 7 days: bedtime, wake time, number of night awakenings." }],
      { bodyHtml: body },
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe("question-restates-heading");
  });

  test("drops a question a recent article already used", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "How long should a nap be?", a: "About 10-20 minutes; past 30 minutes you drop into deep sleep and wake up groggier." }],
      { bodyHtml: body, recentQuestions: ["How long should my nap be?"] },
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe("question-used-recently");
  });

  test("keeps an additive Q&A that brings new information", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "How much does coffee affect sleep?", a: "Caffeine takes about six hours to halve; a cup after 3 p.m. still leaves some in your blood at 11 p.m." }],
      { bodyHtml: body, recentQuestions: ["How long should my nap be?"] },
    );
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });
});

describe("filterFaq demand gate", () => {
  const body = "<p>Measuring results instead of hours helps you work more effectively.</p>";
  const demand = ["how to measure work productivity", "what is productivity"];

  test("keeps a question that covers a real demand query", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "How do you measure work productivity properly?", a: "Track the value you create, not the hours you sit at a desk." }],
      { bodyHtml: body, demand },
    );
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  test("drops a question with no matching demand query", () => {
    const { kept, dropped } = filterFaq(
      [{ q: "What benefits does morning meditation bring?", a: "It leaves the mind calm and the body relaxed through the day." }],
      { bodyHtml: body, demand },
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe("question-no-demand");
  });

  test("fails open when no demand signal is provided", () => {
    const { kept } = filterFaq(
      [{ q: "What benefits does morning meditation bring?", a: "It leaves the mind calm and the body relaxed through the day." }],
      { bodyHtml: body },
    );
    expect(kept).toHaveLength(1);
  });
});
