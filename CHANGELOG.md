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
