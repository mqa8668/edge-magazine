# AGENTS.md

Notes for contributors who use coding agents on this repo.

## What this is

A server-rendered magazine on Cloudflare Workers (Hono SSR, D1 with FTS5, KV, R2, Queues, Cron) with an optional LLM drafting pipeline. See `README.md` and `docs/`.

## Commands

- `npm run typecheck` - `tsc --noEmit`
- `npm test` - vitest
- `npm run check:content` - rejects AI-tell glyphs and emoji in sample content
- `npm run setup:local` then `npm run dev` - local server on http://localhost:8787

Use Node 22 (`.nvmrc`). Run typecheck, tests and the content check before you finish a change.

## Rules

- Never commit secrets, account IDs, or resource IDs. Config goes in `wrangler.toml` `[vars]`, secrets in `.dev.vars` (gitignored) or `wrangler secret put`.
- Pipeline defaults must stay conservative: `pipeline.enabled = false`, `publish.mode = "review"`, `postsPerDay = 1`.
- Do not add scraping of third-party endpoints, use of unofficial APIs, cookie-session automation, or automatic posting to social networks.
- Editorial text and sample content avoid emoji and typographic AI tells (em dashes, arrows, smart quotes). `src/lib/sanitize.ts` enforces this on generated text.
- Keep architecture docs in `docs/` current when you change a binding, cron, route, or data flow.
