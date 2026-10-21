# Changelog

## 0.1.0 (unreleased)

First release, for AI SDK 7 (`LanguageModelV4`).

- `createQuotaPool()`: routes each call to a member that still has headroom. Atomic reserve and commit per member, shared group and budget key; reconciles real usage and provider rate-limit headers; cooldowns on 429; first-token timeout; switches streams only before the first visible chunk.
- Strategies: `priority`, `most-headroom`, `weighted`. Constraints: `require` (tools, vision, json) and `exclude` tags.
- Windows: requests per second, minute and day; tokens per minute and day. Daily windows reset on a rolling 24 h or at local midnight in any time zone.
- Stores: `memoryStore()`, `upstashStore()` (REST), `redisStore()` (ioredis), `postgresStore()` with `postgresSchemaSql()`.
- Budgets per key with `pool.remaining()`; `pool.snapshot()` for status pages.
- Limits registry (`ai-sdk-quota/limits`) for Groq, OpenRouter (shared daily group), Cerebras, Gemini and Mistral, each with its source and verification date.
- `npx ai-sdk-quota probe` reads your real limits from a provider.
- Strips other providers' data from the history when a conversation moves between providers; `stickyKey` keeps a conversation on one member.
- `result.providerMetadata.aiSdkQuota` says which member answered.
- Learns from 429s that name their window (Groq, OpenAI-style, Gemini quota ids): the window counts as full and drains over its length, so the pool resumes one call at a time instead of in a burst; `adaptive` lowers that member's effective limit and recovers it over 5 minutes; `safetyMargin` keeps a fixed share of every provider limit in reserve. Short windows count 1 s of timing slack. Adaptive factors live in the store, so one burst of 429s lowers a limit once for every instance (debounced 10 s). Rate-limit headers are read before message text. OpenRouter "busy upstream" 429s only pause that model briefly; an account-cap 429 marks the shared daily group full.
- Input and output tokens-per-minute windows (`itpm`, `otpm`). Groq applies them to "some organizations" without publishing values; the fair benchmark found an OTPM limit of 1,000 on `qwen3.8-27b`, now in the registry. Charges carry separate input and output estimates, and reconcile replaces each window's estimate with the matching real count.
- Size budget raised from 10 KB to 12 KB (min+gzip, whole core entry) on purpose: the 429 handling above costs ~1.5 KB and is what kept the pool from cascading into 429s on real free tiers, so it stays in the core rather than behind a subpath. A typical import (`createQuotaPool` + `memoryStore`) is about 9.2 KB.
