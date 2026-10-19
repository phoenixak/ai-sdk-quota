# ai-sdk-quota

A quota-aware model pool for the [Vercel AI SDK](https://ai-sdk.dev). Give it several models (free tiers, paid keys, local), and it routes each call to one that **still has headroom**, before you hit a 429.

> Work in progress (Phases 1–2 done: core, shared stores, budgets, probe CLI). Not published yet.

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
- **On failure:**
  - 429: cool down until `retry-after` (or back off), then try the next model.
  - 5xx, network error or first-token timeout: try the next model.
  - Validation errors (400/422) and caller aborts: rethrown, never retried.
- **Streams switch models only before the first chunk reaches you**, so text is never duplicated. After that, errors are passed through.
- **Daily resets** follow the provider: a rolling 24 h, or local midnight (Gemini: midnight Pacific, correct across daylight-saving changes).
- **Mixed providers in one conversation:** data another provider left in the history (e.g. Gemini thought signatures) is stripped before the call. Use `pool.model({ stickyKey: conversationId })` to keep a conversation on one model while it has quota.

Limits for known free tiers live in `ai-sdk-quota/limits`, each entry with its source and the date it was checked (see [PHASE0.md](PHASE0.md)).

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

Keep the store in the same region as your functions. On Upstash's free tier (500K commands a month), one pool call costs about 2–3 commands, so roughly 170k–250k calls a month (estimate; Upstash doesn't document how scripts are counted). Redis Cluster isn't supported yet: every key shares one hash tag.

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

## Policy

Use **one key per provider account**. This package respects provider limits; it doesn't help you get around them. It has no features for rotating many accounts, because that breaks providers' terms.

## Try it without keys

```sh
npm run build && node examples/mock-chat.ts
```

## License

MIT
