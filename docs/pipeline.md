# Content pipeline

The pipeline drafts articles with an LLM and puts them through automated checks. It is optional and ships switched off. Nothing is generated until you turn it on in `/admin`.

## Defaults

| Setting | Default |
| --- | --- |
| `pipeline.enabled` | `false` (kill switch, cron and `/api/run` do nothing) |
| `publish.mode` | `review` (drafts wait for you to approve) |
| `pipeline.postsPerDay` | `1` |
| LLM provider | Workers AI, no key needed |

Other providers (DeepSeek, Groq, any OpenAI-compatible endpoint) are used only if you set their secret and include them in `llm.providerOrder`. Settings live in KV and are edited at `/admin`, with every change recorded in `config_audit`.

## Stages

For each queued topic the pipeline runs these stages in order. A failure at any stage either repairs the draft, re-rolls it, or marks the item failed with a reason.

1. **Ideate.** The model proposes topics per category, using your niche pack (categories, voice, personas, formulas). Optional demand signals such as search suggestions or Search Console queries can be merged in.
2. **Generate.** The article is built in parts: an outline with one job per section, a lead, the sections, then an ending. Building by parts keeps length and structure under control instead of hoping a single prompt obeys a word count.
3. **Validate.** Mechanical checks on title, length, structure, banned openers and closers, and duplicated paragraphs. Each issue maps to the one part that owns it, so repair patches only that part. Length-only failures above `quality.hardMinWords` can be salvaged and published.
4. **Safety.** A term and phrase check runs on the outline, the draft and each FAQ item. Hard hits never publish and force a re-roll. A configurable number of soft hits is tolerated. You can extend term lists and the idiom allow list from config.
5. **Sanitize.** The body is reduced to an allowed set of tags, typography is normalized and unsafe markup is removed.
6. **Dedup.** Topics are normalized and compared (exact key, then token overlap against `quality.similarityThreshold`) with published posts and queued topics. Dropped ideas are logged in `pipeline_ideas` with the reason and the title they collided with.
7. **Publish or review.** With `publish.mode = auto` the post goes live. With `review` it is stored as a held draft with status `awaiting_review`, and you approve or reject it in `/admin/review`. An optional critic pass can score the draft before this step.

## Guardrails

- **Kill switch.** `pipeline.enabled = false` stops cron runs and API-triggered runs.
- **Publishing mode.** `review` is the default so a human sees every post at first.
- **postsPerDay cap.** Fan-out never dispatches more than this many items per day, and the top-up cron only fills a shortfall.
- **Spend caps.** `llm.dailyBudgetUsd` and `llm.monthlyBudgetUsd` are enforced before each call. Past a cap new work is refused and the run stops. Admin test calls are still allowed.
- **Circuit breaker.** Each provider tracks consecutive failures in KV. After five failures it is skipped for ten minutes, then one trial call decides whether to close it. The next provider in `providerOrder` is used meanwhile.
- **Retries.** Rate limits, server errors and timeouts retry with backoff. Other client errors fail over immediately without spending more.
- **Metering.** Every provider attempt writes a row to `llm_calls` with tokens, latency and estimated cost. Costs depend on `llm.pricing`, so set it for non-default models.
- **Alerts.** Failure rate, stale runs and crashes raise in-app notifications and, if configured, Telegram or email.

## Telemetry tables

- `pipeline_runs`: status, counts (requested, ideated, enqueued, skipped as duplicate, published, failed) and a JSON report per run.
- `pipeline_ideas`: what happened to each proposed idea.
- `content_queue`: per-item status, attempts, last error, held draft.
- `llm_calls`: per-attempt cost and latency, filterable by stage in the admin.
- `notifications`: alerts.

Start with `/admin/runs` when something looks wrong. The run detail page links ideas, queue items and LLM calls together.

## FAQ handling

The model returns a short list of question and answer pairs with the article. A filter then drops any item that:

- restates a section heading,
- repeats a question used in recent posts,
- has no matching demand query when demand data is available (skipped when there is none),
- or whose answer mostly repeats the article body.

Items that pass are appended as an FAQ section and mirrored as FAQPage structured data. If nothing passes, the post has no FAQ. That is intended. Unsafe items are dropped individually without failing the article.

## Writing a niche pack

The pack is what makes the pipeline write about your subject in your voice. It lives in `content/niche.ts`, which you create by copying `content/niche.example.ts`. It exports:

- `categories`: the sections of your site, with the topics each one covers.
- `voice`: the house style the model must follow.
- `personas`: author voices, matched to author records.
- `formulas`: article structures the generator rotates through.

Keep voice rules concrete (sentence length, what to avoid, what each paragraph must contain). Vague rules produce vague prose. Write prompts and term lists in the same language as your site, with its normal spelling and accents. See `content/README.md` for the exact fields and a worked example, and [content-styleguide.md](content-styleguide.md) for editorial principles.
