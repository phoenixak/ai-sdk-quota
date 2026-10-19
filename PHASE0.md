# Phase 0: facts

Researched **2026-10-19**. Every limit below comes from the vendor's own page unless marked **unverified**. These values seed `src/limits/registry.json`.

## AI SDK 7

Read from the published type definitions and the npm registry.

- `ai@7.0.143`, `@ai-sdk/provider@4.0.29`. The model spec is **`LanguageModelV4`**: `specificationVersion: 'v4'`, `provider`, `modelId`, `supportedUrls`, `doGenerate(options)`, `doStream(options)`.
- `doGenerate` resolves to `{ content, finishReason, usage, warnings, request?, response?: { headers?, body?, id?, modelId?, timestamp? } }`.
- `usage` is `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, outputTokens: { total, text, reasoning } }`. Every field can be `undefined`.
- `doStream` resolves to `{ stream: ReadableStream<LanguageModelV4StreamPart>, request?, response?: { headers? } }`.
- HTTP providers (e.g. `@ai-sdk/openai-compatible`) await the HTTP response before `doStream` resolves. So:
  - HTTP errors (429, 5xx) are **thrown by `doStream` itself** as `APICallError` with `statusCode`, `responseHeaders`, `responseBody` and `isRetryable`.
  - Response headers of a successful call are available before the first chunk.
  - Errors after the stream has started arrive as `{ type: 'error' }` stream parts.
- Stream parts: `stream-start`, `response-metadata`, `raw`, `text-start` / `text-delta` / `text-end`, `reasoning-start` / `reasoning-delta` / `reasoning-end`, `tool-input-start` / `tool-input-delta` / `tool-input-end`, `tool-call`, `tool-result`, `file`, `source`, `finish`, `error`.
- Test mocks: `MockLanguageModelV4` from `ai/test`.

### Holding back the first chunk

This is how the pool can switch models mid-stream without ever duplicating text.

1. Await the inner `doStream()`. If it throws, the request failed before anything was sent to the caller, so try the next candidate.
2. Read parts into a buffer, holding back `stream-start`, `response-metadata`, `raw`, `text-start` and `reasoning-start`.
3. The first part the caller would actually *see* commits the stream to this model: `text-delta`, `reasoning-delta`, `tool-input-start`, `tool-call`, `tool-result`, `file`, `source` or `finish`.
4. If an `error` part, a reader rejection or the first-token timeout comes before that, cancel the reader and try the next candidate.
5. After commit, return a stream that replays the buffer and then forwards the rest. Errors after commit pass through and never cause a switch.

`streamText` and `generateText` retry on their own (`maxRetries`, default 2) *around* the pool. Pass `maxRetries: 0` so retries happen only inside the pool, where they're quota-aware.

## Provider free tiers

| Provider | Free limits | Scope / reset | Headers and 429 | Source |
|---|---|---|---|---|
| **Groq** (Free plan) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`: 30 RPM, 1K RPD, 8K TPM, 200K TPD. `openai/gpt-oss-safeguard-20b`: 3 RPM, 1K RPD, 2K TPM, 200K TPD | Per organization, listed per model. Cached tokens don't count | Always present: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` (these refer to **RPD**) and the same three for `-tokens` (these refer to **TPM**). Reset values are durations such as `2m59.56s` or `7.66s`. `retry-after` (seconds) is sent only on a 429 | [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits) |
| **Gemini API** | Not published as numbers: "View your active rate limits in AI Studio." Free-tier models include `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and the 2.5 family | "Rate limits are applied per project, not per API key", and they vary per model. RPD resets at **midnight Pacific** | 429 `RESOURCE_EXHAUSTED`; the docs recommend exponential backoff. **Unverified** (forum reports only): the error body carries `google.rpc.RetryInfo` with `retryDelay` (e.g. `"51s"`) and `QuotaFailure` with a `quotaId` | [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [pricing](https://ai.google.dev/gemini-api/docs/pricing), [troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting) |
| **OpenRouter** `:free` models | 20 RPM. 50 RPD with under 10 credits bought in total; 1,000 RPD with 10 or more | **The daily cap is shared across all `:free` models.** "Making additional accounts or API keys will not affect your rate limits." Daily window = the UTC day | No `X-RateLimit-*` headers on successful calls. A 429 carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`, plus `Retry-After` when the upstream gave one. `GET /api/v1/key` returns `free_model_daily_requests { used, limit, remaining }` | [openrouter.ai/docs/api/reference/limits](https://openrouter.ai/docs/api/reference/limits) |
| **Cerebras** | `gpt-oss-120b`, `qwen-3.8-27b`: 5 RPM, 30K uncached TPM, 90K total TPM, 1M TPH, 1M TPD | **Needs a verified payment method** to activate the free credits. Optional; not used in CI | Header names not documented | [inference-docs.cerebras.ai/support/rate-limits](https://inference-docs.cerebras.ai/support/rate-limits) |
| **Mistral** | "Free mode": no credit card. Limits are per model, in tokens per minute and **requests per second**; the numbers appear only in Admin panel → API → Limits | Per organization | Not documented | [usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) |
| **Cloudflare Workers AI** | 10,000 neurons/day; text generation 300 RPM | Resets at 00:00 UTC | Not documented. **Not in the registry yet**: it's metered in neurons, and mapping neurons to tokens would be a guess | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [limits](https://developers.cloudflare.com/workers-ai/platform/limits/) |

Data use: Gemini's free tier is listed as "Used to improve our products: Yes". Use the `may-train` tag and `exclude: ['may-train']` for private data.

### What this means for the design
- **Reset kinds:** `rolling` (Groq), `midnight` in a given time zone (Gemini: `America/Los_Angeles`; OpenRouter: `UTC`). Pacific midnight crosses daylight-saving changes, so days are 23 or 25 hours long twice a year.
- **Limit groups:** quotas shared across models, such as `openrouter:free-daily`, are separate buckets that every member in the group charges.
- **RPS window:** needed for Mistral.
- **Header adapters:** Groq's `requests` headers describe the *daily* limit while its `tokens` headers describe the *per-minute* limit. OpenRouter sends headers only on a 429.
- **Unverified entries** (Gemini, Mistral) ship with conservative defaults and `verified: false`. Use the probe CLI (Phase 2) to read your real limits.

## Infrastructure at $0

| Service | Free tier | Source |
|---|---|---|
| Upstash Redis | 500K commands/month, 256 MB, 10 GB bandwidth | [upstash.com/pricing/redis](https://upstash.com/pricing/redis) |
| Supabase | 2 active projects, 500 MB DB, 5 GB egress, paused after 1 week of inactivity | [supabase.com/pricing](https://supabase.com/pricing) |
| Vercel Hobby | 1M function invocations, 4 CPU-hours, 100 GB transfer, non-commercial only | [vercel.com/docs/plans/hobby](https://vercel.com/docs/plans/hobby) |

Upstash budget: one pool call costs about 2–3 commands (reserve, commit, sometimes a provider-truth update), so 500K commands cover roughly **170k–250k calls a month**.

## Open questions

1. **Spec and stream delegation:** `LanguageModelV4`; see "Holding back the first chunk" above.
2. **Gemini quota:** per project and per model, resetting at midnight Pacific. The vendor page doesn't document a retry delay in the 429 body. The adapter parses `RetryInfo.retryDelay` or "retry in Ns" when present, and otherwise falls back to exponential backoff.
3. **Postgres `reserve()` latency:** one function call per step. Local baseline (Phase 2, Postgres 17 in Docker, `bench/store-latency.mjs`): reserve + commit p50 2.83 ms, p95 3.11 ms; Redis 8: p50 1.06 ms. **Not yet measured on hosted Supabase from Vercel**: run `DATABASE_URL=... BENCH_CREATE_SCHEMA=1 node bench/store-latency.mjs` from the same region. Keep the app and the database in the same region.
4. **Community listing:** a PR to `vercel/ai` adding `content/providers/05-community-providers/NN-<name>.mdx`, with the OpenRouter page as the template. The package must first be published on npm and GitHub.
5. **Name:** `ai-sdk-quota` (free on npm, no GitHub repos with that name).
