// The free-tier soak benchmark: the same chat workload against four contenders.
//
//   npm run build
//   node bench/soak.mjs --mock                       # harness check, simulated providers, no keys
//   node bench/soak.mjs                              # all contenders, real free tiers
//   node bench/soak.mjs --contender pool-priority    # one contender (e.g. one per day)
//   node bench/soak.mjs report                       # markdown table from bench/results/
//
// Keys come from the environment only: GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY.
// Use a Gemini key from a project WITHOUT billing, so every request stays on the free tier.
// Options: --requests 250 (per contender), --rpm 40 (offered load), --concurrency 4.
//
// Free daily quota is about 2,150 requests across the default chain (Groq 2 x 1,000,
// OpenRouter 50, Gemini ~100), so the defaults (4 x 250) fit in one day.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { streamText } from 'ai';
import { createQuotaPool, PoolExhaustedError } from '../dist/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const MOCK = args.includes('--mock');
const RESULTS = new URL('./results/', import.meta.url);
const CONTENDERS = ['single', 'ai-fallback', 'pool-priority', 'pool-headroom'];

if (args[0] === 'report') {
  report();
  process.exit(0);
}

const REQUESTS = Number(flag('requests', MOCK ? 60 : 250));
const RPM = Number(flag('rpm', MOCK ? 240 : 40));
const CONCURRENCY = Number(flag('concurrency', 4));
const ONLY = flag('contender', undefined);
const OPENROUTER_MODEL = process.env.OPENROUTER_FREE_MODEL ?? 'google/gemma-4-26b-a4b-it:free';

// The limits every contender is measured against (documented free tiers, 2026-10-19).
const LIMITS = {
  'groq-oss20b': { rpm: 30, rpd: 1000, provider: 'groq', modelId: 'openai/gpt-oss-20b' },
  'groq-qwen': { rpm: 30, rpd: 1000, provider: 'groq', modelId: 'qwen/qwen3.8-27b' },
  gemini: { rpm: 5, rpd: 100, provider: 'gemini', modelId: 'gemini-3.5-flash-lite' },
  openrouter: { rpm: 20, rpd: 50, provider: 'openrouter', modelId: OPENROUTER_MODEL },
};

const PROMPTS = [
  'In one sentence, what is a rate limit?',
  'Name three fruits, comma separated.',
  'Translate "good morning" to Arabic.',
  'What is 17 times 23? Answer with the number.',
  'Give a one-line tip for writing clear commit messages.',
  'Summarise: The cat sat on the mat because it was warm.',
];

/** Counts every HTTP 429 a provider actually returned. */
function counting(provider, stats) {
  return async (input, init) => {
    const res = await fetch(input, init);
    stats.http[provider] = (stats.http[provider] ?? 0) + 1;
    if (res.status === 429) stats.http429[provider] = (stats.http429[provider] ?? 0) + 1;
    return res;
  };
}

async function realModels(stats) {
  const missing = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Set ${missing.join(', ')} in your environment (or use --mock).`);
    process.exit(1);
  }
  const { createGroq } = await import('@ai-sdk/groq');
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
  const { createOpenRouter } = await import('@openrouter/ai-sdk-provider');
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY, fetch: counting('groq', stats) });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY, fetch: counting('gemini', stats) });
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY, fetch: counting('openrouter', stats) });
  return {
    'groq-oss20b': groq('openai/gpt-oss-20b'),
    'groq-qwen': groq('qwen/qwen3.8-27b'),
    gemini: google('gemini-3.5-flash-lite'),
    openrouter: openrouter(OPENROUTER_MODEL),
  };
}

/** Simulated providers that enforce LIMITS (shared OpenRouter daily cap included) and return 429s. */
async function mockModels(stats) {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { APICallError } = await import('@ai-sdk/provider');
  const sent = {};
  const shared = [];
  const make = (id) => {
    const { rpm, rpd, provider, modelId } = LIMITS[id];
    sent[id] = [];
    return new MockLanguageModelV4({
      provider: `${provider}.chat`,
      modelId,
      doStream: async () => {
        const now = Date.now();
        stats.http[provider] = (stats.http[provider] ?? 0) + 1;
        const lastMinute = sent[id].filter((t) => t > now - 60_000).length;
        const daily = provider === 'openrouter' ? shared : sent[id];
        if (lastMinute >= rpm || daily.length >= rpd) {
          stats.http429[provider] = (stats.http429[provider] ?? 0) + 1;
          throw new APICallError({
            message: 'Rate limit reached',
            url: `https://${provider}.example.com/v1/chat/completions`,
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after': '5' },
            isRetryable: true,
          });
        }
        sent[id].push(now);
        if (provider === 'openrouter') shared.push(now);
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] });
              c.enqueue({ type: 'text-start', id: '1' });
              c.enqueue({ type: 'text-delta', id: '1', delta: 'ok' });
              c.enqueue({ type: 'text-end', id: '1' });
              c.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 8, text: 8, reasoning: undefined },
                },
              });
              c.close();
            },
          }),
        };
      },
    });
  };
  return Object.fromEntries(Object.keys(LIMITS).map((id) => [id, make(id)]));
}

function contenderModel(name, models) {
  const chain = Object.keys(LIMITS);
  if (name === 'single') return { model: models['groq-oss20b'], maxRetries: 2 };
  if (name === 'ai-fallback') {
    return import('ai-fallback').then(({ createFallback }) => ({
      model: createFallback({ models: chain.map((id) => models[id]), modelResetInterval: 60_000 }),
      maxRetries: 2,
    }));
  }
  const pool = createQuotaPool({
    models: [
      { id: 'groq-oss20b', model: models['groq-oss20b'], limits: 'groq:free' },
      { id: 'groq-qwen', model: models['groq-qwen'], limits: 'groq:free' },
      { id: 'gemini', model: models.gemini, limits: { rpm: 5, rpd: 100, dailyReset: { timeZone: 'America/Los_Angeles' } } },
      { id: 'openrouter', model: models.openrouter, limits: { rpm: 20 }, groups: ['openrouter:free-daily'] },
    ],
    strategy: name === 'pool-headroom' ? 'most-headroom' : 'priority',
    expectedOutputTokens: 128,
  });
  return { model: pool.model(), maxRetries: 0, pool };
}

async function run(name) {
  const stats = { http: {}, http429: {} };
  const models = MOCK ? await mockModels(stats) : await realModels(stats);
  const { model, maxRetries } = await contenderModel(name, models);
  const results = [];
  const gapMs = 60_000 / RPM;
  const startedAt = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= REQUESTS) return;
      // Offered load: request i starts no earlier than i * gap.
      const wait = startedAt + i * gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const t0 = Date.now();
      let firstToken;
      let streamError;
      const record = { i, startedAt: t0 };
      try {
        const result = streamText({
          model,
          prompt: PROMPTS[i % PROMPTS.length],
          // Room for the reasoning models (gpt-oss, qwen) to think briefly and still answer.
          maxOutputTokens: 256,
          providerOptions: { groq: { reasoningEffort: 'low' } },
          maxRetries,
          onChunk: () => {
            firstToken ??= Date.now();
          },
          // streamText wraps a pre-output failure; onError sees the original.
          onError: ({ error }) => {
            streamError = error;
          },
        });
        const text = await result.text;
        const response = await result.response;
        const served = (await result.providerMetadata)?.aiSdkQuota;
        record.ok = text.length > 0;
        if (!record.ok) record.error = 'empty-text';
        record.modelId = served?.memberId ?? response.modelId;
        record.ttftMs = (firstToken ?? Date.now()) - t0;
      } catch (error) {
        record.ok = false;
        const original = streamError ?? error;
        record.error = isRefusal(original) || isRefusal(error) ? 'refused-locally' : (original?.name ?? 'Error');
      }
      record.latencyMs = Date.now() - t0;
      results.push(record);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const summary = summarise(name, results, stats);
  mkdirSync(RESULTS, { recursive: true });
  const file = new URL(`${new Date().toISOString().slice(0, 10)}-${MOCK ? 'mock-' : ''}${name}.json`, RESULTS);
  writeFileSync(file, JSON.stringify({ summary, config: { REQUESTS, RPM, CONCURRENCY, MOCK, OPENROUTER_MODEL }, results }, null, 2));
  console.log(JSON.stringify(summary));
}

/** The pool said no without calling a provider. streamText may wrap it, so follow the causes. */
function isRefusal(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof PoolExhaustedError || e.name === 'PoolExhaustedError') return true;
  }
  return false;
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(name, results, stats) {
  const ok = results.filter((r) => r.ok);
  const perModel = {};
  for (const r of ok) perModel[r.modelId] = (perModel[r.modelId] ?? 0) + 1;
  return {
    contender: name,
    mock: MOCK,
    requests: results.length,
    success: ok.length,
    successRate: results.length ? ok.length / results.length : 0,
    refusedLocally: results.filter((r) => r.error === 'refused-locally').length,
    failed: results.filter((r) => !r.ok && r.error !== 'refused-locally' && r.error !== 'empty-text').length,
    emptyText: results.filter((r) => r.error === 'empty-text').length,
    http429: Object.values(stats.http429).reduce((a, b) => a + b, 0),
    httpRequests: Object.values(stats.http).reduce((a, b) => a + b, 0),
    http429ByProvider: stats.http429,
    servedByModel: perModel,
    latencyP50: pct(ok.map((r) => r.latencyMs), 50),
    latencyP95: pct(ok.map((r) => r.latencyMs), 95),
    ttftP50: pct(ok.map((r) => r.ttftMs), 50),
    ttftP95: pct(ok.map((r) => r.ttftMs), 95),
    costUsd: 0,
  };
}

function report() {
  const files = readdirSync(RESULTS).filter((f) => f.endsWith('.json'));
  const rows = files.map((f) => JSON.parse(readFileSync(new URL(f, RESULTS), 'utf8')).summary);
  console.log('| Contender | Success | 429s received | Refused locally | p50 / p95 latency | p50 TTFT | Cost |');
  console.log('|---|---|---|---|---|---|---|');
  for (const s of rows.sort((a, b) => CONTENDERS.indexOf(a.contender) - CONTENDERS.indexOf(b.contender))) {
    const ms = (v) => (v === null ? 'n/a' : `${v} ms`);
    console.log(
      `| ${s.contender}${s.mock ? ' (mock)' : ''} | ${(s.successRate * 100).toFixed(1)}% (${s.success}/${s.requests}) | ${s.http429} | ${s.refusedLocally} | ${ms(s.latencyP50)} / ${ms(s.latencyP95)} | ${ms(s.ttftP50)} | $${s.costUsd} |`,
    );
  }
}

for (const name of ONLY ? [ONLY] : CONTENDERS) {
  if (!CONTENDERS.includes(name)) {
    console.error(`Unknown contender "${name}". Use one of: ${CONTENDERS.join(', ')}`);
    process.exit(1);
  }
  console.log(`\n== ${name}: ${REQUESTS} requests at ${RPM} rpm, concurrency ${CONCURRENCY}${MOCK ? ' (mock)' : ''}`);
  await run(name);
}
