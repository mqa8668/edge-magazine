# Editorial guide

A short, language-neutral guide for anyone writing or reviewing posts, human or generated. Your niche pack (`content/niche.ts`) holds the language-specific rules. This page is about the principles behind them.

## Write for one reader

Pick a specific person with a specific question and answer it. If you cannot name the question in one sentence, the post is not ready.

## Structure

- Open with the point or a concrete scene, not with background or a definition.
- Give each section one job and one concrete element: a number, an example, a common mistake, an exception or a comparison. Two sections should not do the same job.
- Keep paragraphs short, usually two to four sentences.
- Close by returning to the opening idea or giving one clear next step. Do not summarize what you just said.

## Voice

- Plain words. Prefer the short one.
- Say what is true and how sure you are. Hedge once, where it matters.
- Vary sentence length. Avoid a run of sentences with the same shape.
- Skip stock openers ("In today's world"), stock closers ("In conclusion"), and filler such as "it is important to note".
- No hype words. Let the facts carry the weight.

## Facts and care

- Do not invent studies, statistics, quotes or sources. If a number has no source you can name, leave it out or say it is approximate.
- Be careful with health, money, legal and safety topics. Give general information, name the limits, and point to a professional where the stakes are high.
- Do not give instructions that could cause harm.

## FAQ

Include a question only if a real reader would search for it and the answer adds something the article does not already say. An article with no FAQ is fine.

## Formatting and typography

- Use straight quotes, hyphens or commas instead of em dashes, and no decorative emoji in published text.
- Headings should describe the section, not tease it.
- Images need useful alt text. Credit stock photos when the provider asks for it.

## Review checklist

1. Does the title match what the article delivers?
2. Is every claim either checkable or clearly marked as opinion?
3. Does each section add something the others do not?
4. Would you be comfortable if the author were named next to it?

`npm run check:content` scans seed content for typography and format problems. Run it before committing sample posts.
