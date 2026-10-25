# ai-sdk-quota

A quota-aware model pool for the [Vercel AI SDK](https://ai-sdk.dev). Give it several models (free tiers, paid keys, local), and it routes each call to one that **still has headroom**, before you hit a 429.

```sh
npm i ai-sdk-quota
```

```ts
import { streamText } from 'ai';
import { createQuotaPool } from 'ai-sdk-quota';
import { groq } from '@ai-sdk/groq';
import { google } from '@ai-sdk/google';

const pool = createQuotaPool({
  models: [
    { id: 'groq-oss', model: groq('openai/gpt-oss-120b'), limits: 'groq:free' },
    { id: 'gemini-lite', model: google('gemini-3.5-flash-lite'), limits: 'gemini:free', tags: ['may-train'] },
  ],
  onEvent: (e) => console.log(e), // route | skip | fail | cooldown | reconcile | exhausted
});

const result = streamText({
  model: pool.model({ exclude: ['may-train'] }), // keep private data off tiers that may train on it
  maxRetries: 0, // let the pool retry: it knows about quotas
  prompt: 'Hello!',
});
```

`pool.model()` returns a normal `LanguageModelV4`, so tools, structured output, `streamText` and `useChat` work unchanged.

## How it works

- **Before each call** it estimates the tokens (prompt length, plus a running average of each model's real replies) and **atomically reserves** capacity in every window that applies: per minute, per day, per second, tokens per minute and per day, for the model, any shared group (e.g. OpenRouter's daily cap across all `:free` models) and an optional budget key (a user or tenant).
- **After the call** it replaces the estimate with real usage and reads the provider's rate-limit headers (Groq, OpenAI-style, OpenRouter, Gemini error bodies) to correct its counters.
- **When a provider disagrees:** a 429 that names its window ("requests per minute (RPM)", a Gemini per-minute quota) means the provider counts it full. The pool takes that as truth, lets it drain over the window, and (`adaptive`, on by default) lowers that member's effective limit, recovering it over 5 minutes. Providers don't always allow their published rate: on 2026-10-19 one free Groq account sustained about 20 of a published 30 requests per minute. The adapted limit lives in the store, so with a shared store one burst of 429s lowers it once for every instance. Turn it off with `adaptive: false`; reserve a fixed share of every limit with `safetyMargin: 0.9`.
- **Busy models vs. your quota:** OpenRouter's "temporarily rate-limited upstream" 429s mean the free model's host is busy, so the pool pauses that model briefly and doesn't count it against your shared daily cap.
- **On failure:**
  - 429: cool down until `retry-after` (or back off), then try the next model.
  - 5xx, network error or first-token timeout: try the next model.
  - Validation errors (400/422) and caller aborts: rethrown, never retried.
- **Streams switch models only before the first chunk reaches you**, so text is never duplicated. After that, errors are passed through.
- **Daily resets** follow the provider: a rolling 24 h, or local midnight (Gemini: midnight Pacific, correct across daylight-saving changes).
- **Mixed providers in one conversation:** data another provider left in the history (e.g. Gemini thought signatures) is stripped before the call. Use `pool.model({ stickyKey: conversationId })` to keep a conversation on one model while it has quota.

Limits for known free tiers live in `ai-sdk-quota/limits`, each entry with its source and the date it was checked (see [PHASE0.md](PHASE0.md)).

## Benchmark

`bench/soak.mjs` compares this pool with [`ai-fallback`](https://github.com/remorses/ai-fallback) on real free tiers (Groq, Gemini, OpenRouter). To keep it fair, the two take turns in blocks (A B B A A B B A …) inside the same time window, with the same models and the same seeded request mix, so both face the same quota state. It counts the 429s providers actually returned at the HTTP layer, records which limit each one names, and reports per-block ranges. The raw results (account ids redacted) are committed next to the table so anyone can check them.

**Run of 2026-10-25** (commit `ee9e776`; Groq `gpt-oss-20b` + `qwen3.8-27b`, Gemini `3.5-flash-lite`, OpenRouter `gemma-4-26b:free`; 400 requests per side in 10 alternating blocks of 40, 40 requests/min offered, seed 42; raw data: [`bench/results/2026-10-25-interleaved.json`](bench/results/2026-10-25-interleaved.json)):

| | ai-sdk-quota (`priority`) | ai-fallback |
|---|---|---|
| Answered | 98.3% (393/400) | 100% (400/400) |
| 429s received per request (per-block range) | **0.040** (0.000–0.075) | 0.058 (0.025–0.125) |
| …per-minute request limits (RPM) | **9** | 15 |
| …Groq output tokens per minute (OTPM) | **4** | 6 |
| …busy upstream (OpenRouter) | 3 | 2 |
| Refused locally (no provider call) | 7 | 0 |
| Latency p50 / p95 | 345 / 698 ms | 365 / 711 ms |
| Cost | $0 | $0 |

What it shows, honestly: the pool received about 31% fewer 429s, with similar latency. The per-block ranges overlap, so this is an improvement, not a knockout. The trade-off is 7 local refusals (1.75%): moments when every member was at its limit, where the pool said no at once while ai-fallback's retries waited it out. If you'd rather wait than fail fast, keep the AI SDK's default `maxRetries` instead of `0`.

An earlier run (2026-10-21, commit `6682de8`, before input/output token limits were modelled) measured 0.077 vs 0.100 429s per request; 21 of the pool's 31 429s were then Groq's OTPM limit ([raw data](bench/results/2026-10-21-interleaved.json)).

Run it with your own keys:

```sh
npm run build
GROQ_API_KEY=... OPENROUTER_API_KEY=... GEMINI_API_KEY=... node bench/soak.mjs
node bench/soak.mjs report
```

## Stores

`memoryStore()` (the default) keeps state in one process. On serverless every instance has its own copy, so use a shared store there. All of them pass the same test suite, including concurrent reserves from separate connections.

```ts
// Upstash Redis over REST: no client dependency, works on Vercel and Cloudflare Workers.
import { upstashStore } from 'ai-sdk-quota/stores/upstash';
const store = upstashStore({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });

// Any Redis server, through ioredis.
import { Redis } from 'ioredis';
import { redisStore } from 'ai-sdk-quota/stores/redis';
const store = redisStore(new Redis(process.env.REDIS_URL!));

// Postgres (Supabase, Neon, RDS): run postgresSchemaSql() once as a migration,
// then grant EXECUTE on quota_op(jsonb) to your server's role (e.g. service_role).
import pg from 'pg';
import { postgresStore, postgresSchemaSql } from 'ai-sdk-quota/stores/postgres';
const store = postgresStore(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
```

| Store | Store work per pool call (reserve + commit), local benchmark |
|---|---|
| Redis 8 | p50 1.1 ms |
| Postgres 17 | p50 2.8 ms (one function call per step, under an advisory lock) |
| Upstash | two HTTPS requests; add your region's round trip twice |

**Keep the store in the same region as your app**: every pool call talks to it twice. On Upstash's free tier (500K commands a month), one pool call costs about 2–3 commands, so roughly 170k–250k calls a month (estimate; Upstash doesn't document how scripts are counted). Redis Cluster isn't supported yet: every key shares one hash tag.

## Budgets

```ts
const pool = createQuotaPool({ models, store, budgets: { perKey: { rpd: 50, tpd: 100_000 } } });
streamText({ model: pool.model({ budgetKey: userId }), prompt });
const left = (await pool.remaining(userId)).rpd?.remaining; // "you have 12 messages left today"
```

## Probe your real limits

Limits differ by account and change often. Send one tiny request with your own key and read what the provider reports:

```sh
GROQ_API_KEY=... npx ai-sdk-quota probe --provider groq
OPENROUTER_API_KEY=... npx ai-sdk-quota probe --provider openrouter
npx ai-sdk-quota probe --provider gemini   # explains where Google shows your limits
```

The key is read from an environment variable, never from the command line.

The core is about 10 KB minified and gzipped (9.2 KB for a typical `createQuotaPool` + `memoryStore` import); each store adds about 5 KB.

## Policy

Use **one key per provider account**. This package respects provider limits; it doesn't help you get around them. It has no features for rotating many accounts, because that breaks providers' terms.

## Try it without keys

```sh
npm run build && node examples/mock-chat.ts
```

## License

MIT
