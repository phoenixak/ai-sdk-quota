// Runs without API keys: two mock models, the first one rate-limited.
// npm run build && node examples/mock-chat.ts
import { APICallError } from '@ai-sdk/provider';
import { streamText } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { createQuotaPool } from 'ai-sdk-quota';

const limited = new MockLanguageModelV4({
  provider: 'groq.chat',
  modelId: 'openai/gpt-oss-120b',
  doStream: async () => {
    throw new APICallError({
      message: 'Rate limit reached',
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': '12' },
      isRetryable: true,
    });
  },
});

const healthy = new MockLanguageModelV4({
  provider: 'mistral.chat',
  modelId: 'small',
  doStream: async () => ({
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      ...['Hello ', 'from ', 'the ', 'second ', 'model.'].map((delta) => ({ type: 'text-delta' as const, id: '1', delta })),
      { type: 'text-end', id: '1' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 9, noCache: 9, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
      },
    ]),
  }),
});

const pool = createQuotaPool({
  models: [
    { id: 'groq', model: limited, limits: 'groq:free' },
    { id: 'mistral', model: healthy, limits: { rps: 1, tpm: 100_000 } },
  ],
  onEvent: (e) => console.log('[pool]', JSON.stringify(e, (k, v) => (k === 'error' ? String(v) : v))),
});

const result = streamText({ model: pool.model(), prompt: 'Say hello', maxRetries: 0 });
let text = '';
for await (const delta of result.textStream) text += delta;
console.log('text:', JSON.stringify(text));
console.log('snapshot:', JSON.stringify(await pool.snapshot()));
