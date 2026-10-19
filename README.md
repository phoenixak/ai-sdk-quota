# ai-sdk-quota

A quota-aware model pool for the [Vercel AI SDK](https://ai-sdk.dev). Give it several models (free tiers, paid keys, local), and it routes each call to one that **still has headroom**, before you hit a 429.

> Work in progress. Not published yet.

```ts
import { streamText } from 'ai';
import { createQuotaPool, memoryStore } from 'ai-sdk-quota';
import { groq } from '@ai-sdk/groq';
import { google } from '@ai-sdk/google';

const pool = createQuotaPool({
  models: [
    { id: 'groq-oss', model: groq('openai/gpt-oss-120b'), limits: 'groq:free:openai/gpt-oss-120b' },
    { id: 'gemini-lite', model: google('gemini-3.5-flash-lite'), limits: { rpm: 5, rpd: 100 }, tags: ['may-train'] },
  ],
  store: memoryStore(),
});

const result = streamText({
  model: pool.model({ exclude: ['may-train'] }),
  maxRetries: 0, // the pool does the retrying, and it knows about quotas
  prompt: 'Hello!',
});
```

## Policy

Use **one key per provider account**. This package respects provider limits; it doesn't help you get around them. It has no features for rotating many accounts, because that breaks providers' terms.

## License

MIT
