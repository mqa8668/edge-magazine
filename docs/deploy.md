# Deploy

## One click

[![Deploy to Cloudflare](https://deploy.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mqa8668/edge-magazine)

The button clones the repository into your account and provisions the D1 database, KV namespace, R2 bucket and queue named in `wrangler.toml`. After it finishes, add the secrets below and seed the database.

## Manual

Requirements: Node 22 or 24, a Cloudflare account.

```
npm install
npx wrangler login
npm run deploy
```

`npm run deploy` runs `predeploy` first (typecheck, content check, tests), then applies D1 migrations to the remote database and deploys the Worker. Wrangler creates the bindings on first deploy and writes their IDs for you.

## Secrets

Set each with `npx wrangler secret put NAME`.

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD_HASH` | Yes | Login hash for `/admin`. Create it with `npm run admin:hash -- "your password"`. Empty means `/admin` is disabled |
| `SESSION_SECRET` | Yes | Long random string used to sign admin sessions |
| `PUBLISH_TOKEN` | Yes | Bearer token for the `/api` endpoints. Empty disables them |
| `DEEPSEEK_API_KEY` | No | Enables the DeepSeek provider |
| `GROQ_API_KEY` | No | Enables the Groq provider |
| `OPENAI_COMPAT_API_KEY` | No | Any OpenAI-compatible endpoint. Also set `llm.openaiCompat` in `/admin` |
| `PEXELS_API_KEY` | No | Stock photos. Without them, generated placeholder covers are used |
| `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | No | Ops alerts |
| `TURNSTILE_SECRET_KEY` | No | Newsletter form bot check. Pair with `TURNSTILE_SITE_KEY` in `[vars]` |

Workers AI needs no key, so the pipeline can run with only the three required secrets.

## Seed and first run

```
npm run seed:remote
```

This loads sample content so the site is not empty. Replace it with your own through `/admin` or `/api/publish`. Open `/admin`, review the config, and only then enable the pipeline. It starts disabled with review mode on and one post per day.

Local development: copy `.dev.vars.example` to `.dev.vars`, then `npm run setup:local` and `npm run dev`.

## Custom domain

In the dashboard open Workers, your Worker, Settings, Domains and Routes, and add a Custom Domain on a zone in your account. Then set `SITE_URL` in `wrangler.toml` `[vars]` (for example `https://example.com`) and redeploy so canonical URLs, sitemaps and the feed use it. Other public vars (`SITE_NAME`, analytics IDs, `INDEXNOW_KEY`, `AI_GATEWAY`) are in the same block.

## Free plan notes

The site itself runs on the Workers Free plan within its request and CPU limits, but check these before relying on it:

- **Queues.** Generation jobs go through a Cloudflare Queue. Check in your account whether Queues are available on your plan. A cron-only fallback that generates without a queue is not implemented yet, and the inline fallback in code is meant for local development only, because it is limited by the short request time budget.
- **Cron.** Three triggers are declared. Free accounts have a limit on the number of cron triggers per account, so you may need to remove one (the heartbeat is the easiest to drop).
- **CPU time.** Free Workers have a short CPU limit per request. Heavy pages or admin actions may hit it. The paid plan raises it.
- **Limits in general.** D1, KV and R2 free quotas apply. Cloudflare changes these over time, so read the current limits page rather than trusting this list.

If you only want the magazine without generation, leave the pipeline disabled and publish through `/admin` or the API.
