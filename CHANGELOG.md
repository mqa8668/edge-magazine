# Changelog

## 0.1.0

Initial public release.

- Server-rendered read plane on Workers (Hono): home, category, post, tag, author, topic cluster, search (D1 FTS5), sitemaps, RSS, robots, legal pages.
- Caching with KV and the Cache API.
- Admin panel with password login, runtime config in KV, audit log and a review queue.
- Optional LLM drafting pipeline: disabled by default, `publish.mode = "review"`, one post per day, Workers AI as the default provider, spend caps, circuit breaker, validation, safety filter and duplicate detection.
- Six original sample articles with generated SVG covers.
