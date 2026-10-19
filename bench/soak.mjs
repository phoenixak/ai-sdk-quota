// The free-tier soak benchmark.
//
//   npm run build
//   node bench/soak.mjs --mock                         # harness check with simulated providers, no keys
//   node bench/soak.mjs                                # fair comparison (interleaved blocks), real free tiers
//   node bench/soak.mjs --sequential                   # every contender in turn (single, ai-fallback, pools)
//   node bench/soak.mjs report [file]                  # markdown table from bench/results/
//
// Keys come from the environment only: GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY.
// Use a Gemini key from a project WITHOUT billing, so every request stays on the free tier.
//
// Interleaved (default): two contenders (--contenders pool-priority,ai-fallback) take turns
// in blocks of --block requests, in the order A B B A A B B A ..., inside the same time
// window, with the same models and the same seeded request sequence (--seed). Each side
// keeps its own state across its blocks. Results report per-block ranges.
// Options: --requests 400 (per side), --block 40, --rpm 40 (offered load), --concurrency 4.
//
// Free daily quota is about 2,150 requests across the default chain (Groq 2 x 1,000,
// OpenRouter 50, Gemini ~120), so 2 x 400 fits in one day with room to spare.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { streamText } from 'ai';
import { PoolExhaustedError, createQuotaPool } from '../dist/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const MOCK = args.includes('--mock');
const RESULTS = new URL('./results/', import.meta.url);
const ALL = ['single', 'ai-fallback', 'pool-priority', 'pool-headroom'];

if (args[0] === 'report') {
  report(args[1]);
  process.exit(0);
}

const SEQUENTIAL = args.includes('--sequential');
const REQUESTS = Number(flag('requests', MOCK ? 80 : SEQUENTIAL ? 250 : 400));
const BLOCK = Number(flag('block', MOCK ? 20 : 40));
const RPM = Number(flag('rpm', MOCK ? 600 : 40));
const CONCURRENCY = Number(flag('concurrency', 4));
const MARGIN = Number(flag('margin', 1));
const SEED = Number(flag('seed', 42));
const TAG = flag('tag', undefined);
const PAIR = flag('contenders', 'pool-priority,ai-fallback').split(',');
const OPENROUTER_MODEL = process.env.OPENROUTER_FREE_MODEL ?? 'google/gemma-4-26b-a4b-it:free';

// The chain every contender uses (documented free tiers, 2026-10-19).
const LIMITS = {
  'groq-oss20b': { rpm: 30, rpd: 1000, provider: 'groq', modelId: 'openai/gpt-oss-20b' },
  'groq-qwen': { rpm: 30, rpd: 1000, provider: 'groq', modelId: 'qwen/qwen3.8-27b' },
  gemini: { rpm: 15, rpd: 120, provider: 'gemini', modelId: 'gemini-3.5-flash-lite' },
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

/** Deterministic request mix: the same prompt sequence for every contender. */
function promptSequence(n, seed) {
  let x = seed >>> 0 || 1;
  return Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % PROMPTS.length;
  });
}

const redact = (text) => text.replace(/\s+/g, ' ').replace(/\borg_[A-Za-z0-9]+/g, 'org_REDACTED');

/** Which limit a 429 says it hit, from its body. */
function triggerOf(body) {
  if (/rate-limited upstream/i.test(body)) return 'upstream';
  const named = /\((RPS|RPM|RPD|TPM|TPD)\)/i.exec(body);
  if (named) return named[1].toLowerCase();
  if (/PerMinute/.test(body)) return /Token/.test(body) ? 'tpm' : 'rpm';
  if (/PerDay/.test(body)) return /Token/.test(body) ? 'tpd' : 'rpd';
  return 'unknown';
}

function newStats() {
  return { sends: [], samples429: [] };
}

/** Wraps a provider's fetch: records every response's status and rate-limit headers. */
function recording(provider, stats) {
  return async (input, init) => {
    const res = await fetch(input, init);
    const h = (name) => res.headers.get(name) ?? undefined;
    const send = {
      t: Date.now(),
      provider,
      status: res.status,
      remainingRequests: h('x-ratelimit-remaining-requests'),
      remainingTokens: h('x-ratelimit-remaining-tokens'),
      retryAfter: h('retry-after'),
    };
    if (res.status === 429) {
      const body = redact(await res.clone().text());
      send.trigger = triggerOf(body);
      if (stats.samples429.length < 12) stats.samples429.push(body.slice(0, 400));
    }
    stats.sends.push(send);
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
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY, fetch: recording('groq', stats) });
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY, fetch: recording('gemini', stats) });
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY, fetch: recording('openrouter', stats) });
  return {
    'groq-oss20b': groq(LIMITS['groq-oss20b'].modelId),
    'groq-qwen': groq(LIMITS['groq-qwen'].modelId),
    gemini: google(LIMITS.gemini.modelId),
    openrouter: openrouter(OPENROUTER_MODEL),
  };
}

/** Simulated providers enforcing LIMITS (shared OpenRouter daily cap included), returning Groq-style 429s. */
const mockState = { sent: {}, shared: [] };
async function mockModels(stats) {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { APICallError } = await import('@ai-sdk/provider');
  const make = (id) => {
    const { rpm, rpd, provider, modelId } = LIMITS[id];
    mockState.sent[id] ??= [];
    const sent = mockState.sent[id];
    return new MockLanguageModelV4({
      provider: `${provider}.chat`,
      modelId,
      doStream: async () => {
        const now = Date.now();
        const daily = provider === 'openrouter' ? mockState.shared : sent;
        const full = sent.filter((t) => t > now - 60_000).length >= rpm || daily.length >= rpd;
        stats.sends.push({ t: now, provider, status: full ? 429 : 200, ...(full ? { trigger: 'rpm' } : {}) });
        if (full) {
          throw new APICallError({
            message: 'Rate limit reached',
            url: `https://${provider}.example.com/v1/chat/completions`,
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { 'retry-after': '2' },
            responseBody: JSON.stringify({ error: { message: 'Rate limit reached on requests per minute (RPM). Please try again in 2s.' } }),
            isRetryable: true,
          });
        }
        sent.push(now);
        if (provider === 'openrouter') mockState.shared.push(now);
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

async function createContender(name) {
  if (!ALL.includes(name)) {
    console.error(`Unknown contender "${name}". Use one of: ${ALL.join(', ')}`);
    process.exit(1);
  }
  const stats = newStats();
  const models = MOCK ? await mockModels(stats) : await realModels(stats);
  const chain = Object.keys(LIMITS).map((id) => models[id]);
  if (name === 'single') return { name, stats, model: models['groq-oss20b'], maxRetries: 2 };
  if (name === 'ai-fallback') {
    const { createFallback } = await import('ai-fallback');
    return { name, stats, model: createFallback({ models: chain, modelResetInterval: 60_000 }), maxRetries: 2 };
  }
  const pool = createQuotaPool({
    models: [
      { id: 'groq-oss20b', model: models['groq-oss20b'], limits: 'groq:free' },
      { id: 'groq-qwen', model: models['groq-qwen'], limits: 'groq:free' },
      { id: 'gemini', model: models.gemini, limits: 'gemini:free' },
      { id: 'openrouter', model: models.openrouter, limits: 'openrouter:free' },
    ],
    strategy: name === 'pool-headroom' ? 'most-headroom' : 'priority',
    safetyMargin: MARGIN,
    expectedOutputTokens: 128,
  });
  return { name, stats, model: pool.model(), maxRetries: 0 };
}

/** The pool said no without calling a provider. streamText may wrap it, so follow the causes. */
function isRefusal(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof PoolExhaustedError || e.name === 'PoolExhaustedError') return true;
  }
  return false;
}

/** Runs `prompts` through one contender at the offered load; returns per-request records. */
async function runBlock(contender, prompts, block) {
  const records = [];
  const gapMs = 60_000 / RPM;
  const startedAt = Date.now();
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= prompts.length) return;
      const wait = startedAt + i * gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const t0 = Date.now();
      let firstToken;
      let streamError;
      const record = { block, i, startedAt: t0 };
      try {
        const result = streamText({
          model: contender.model,
          prompt: PROMPTS[prompts[i]],
          // Room for the reasoning models (gpt-oss, qwen) to think briefly and still answer.
          maxOutputTokens: 256,
          providerOptions: { groq: { reasoningEffort: 'low' } },
          maxRetries: contender.maxRetries,
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
      records.push(record);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return records;
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(name, records, sends) {
  const ok = records.filter((r) => r.ok);
  const by = (list, key) => list.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] ?? 0) + 1), acc), {});
  const http429 = sends.filter((s) => s.status === 429);
  return {
    contender: name,
    mock: MOCK,
    requests: records.length,
    success: ok.length,
    successRate: records.length ? ok.length / records.length : 0,
    refusedLocally: records.filter((r) => r.error === 'refused-locally').length,
    emptyText: records.filter((r) => r.error === 'empty-text').length,
    failed: records.filter((r) => !r.ok && r.error !== 'refused-locally' && r.error !== 'empty-text').length,
    httpRequests: sends.length,
    http429: http429.length,
    http429PerRequest: records.length ? http429.length / records.length : 0,
    http429ByProvider: by(http429, 'provider'),
    http429ByTrigger: by(http429, 'trigger'),
    servedByModel: by(ok, 'modelId'),
    latencyP50: pct(ok.map((r) => r.latencyMs), 50),
    latencyP95: pct(ok.map((r) => r.latencyMs), 95),
    ttftP50: pct(ok.map((r) => r.ttftMs), 50),
    costUsd: 0,
  };
}

const range = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};

function save(name, data) {
  mkdirSync(RESULTS, { recursive: true });
  const file = new URL(`${new Date().toISOString().slice(0, 10)}-${MOCK ? 'mock-' : ''}${TAG ? `${TAG}-` : ''}${name}.json`, RESULTS);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function interleaved() {
  const [a, b] = await Promise.all(PAIR.map(createContender));
  const blocks = Math.ceil(REQUESTS / BLOCK);
  const prompts = promptSequence(REQUESTS, SEED);
  const records = { [a.name]: [], [b.name]: [] };
  const perBlock = [];
  console.log(`interleaved: ${a.name} vs ${b.name}, ${blocks} blocks of ${BLOCK} per side at ${RPM} rpm, seed ${SEED}${MOCK ? ' (mock)' : ''}`);
  for (let k = 0; k < blocks; k++) {
    const slice = prompts.slice(k * BLOCK, (k + 1) * BLOCK);
    // A B B A A B B A ...: neither side always goes first.
    const order = k % 2 === 0 ? [a, b] : [b, a];
    for (const c of order) {
      const sendsBefore = c.stats.sends.length;
      const rs = await runBlock(c, slice, k);
      records[c.name].push(...rs);
      const s = summarise(c.name, rs, c.stats.sends.slice(sendsBefore));
      perBlock.push({ block: k, contender: c.name, successRate: s.successRate, http429PerRequest: s.http429PerRequest });
      console.log(`  block ${k + 1}/${blocks} ${c.name}: ${s.success}/${s.requests} ok, ${s.http429} 429s`);
    }
  }
  const sides = [a, b].map((c) => {
    const s = summarise(c.name, records[c.name], c.stats.sends);
    const mine = perBlock.filter((p) => p.contender === c.name);
    return {
      ...s,
      perBlock: { successRate: range(mine.map((p) => p.successRate)), http429PerRequest: range(mine.map((p) => p.http429PerRequest)) },
      samples429: c.stats.samples429,
    };
  });
  const file = save('interleaved', {
    config: { mode: 'interleaved', contenders: PAIR, REQUESTS, BLOCK, RPM, CONCURRENCY, MARGIN, SEED, OPENROUTER_MODEL, MOCK },
    sides,
    perBlock,
    sends: Object.fromEntries([a, b].map((c) => [c.name, c.stats.sends])),
    records,
  });
  console.log(`saved ${file.pathname}`);
}

async function sequential() {
  const only = flag('contender', undefined);
  for (const name of only ? [only] : ALL) {
    const c = await createContender(name);
    console.log(`== ${name}: ${REQUESTS} requests at ${RPM} rpm${MOCK ? ' (mock)' : ''}`);
    const rs = await runBlock(c, promptSequence(REQUESTS, SEED), 0);
    const summary = { ...summarise(name, rs, c.stats.sends), samples429: c.stats.samples429 };
    save(name, {
      config: { mode: 'sequential', REQUESTS, RPM, CONCURRENCY, MARGIN, SEED, MOCK, OPENROUTER_MODEL },
      summary,
      sends: c.stats.sends,
      records: rs,
    });
    console.log(JSON.stringify({ contender: name, success: summary.success, requests: summary.requests, http429: summary.http429 }));
  }
}

function report(fileArg) {
  const files = fileArg ? [fileArg] : readdirSync(RESULTS).filter((f) => f.endsWith('.json')).map((f) => new URL(f, RESULTS));
  const ms = (v) => (v === null ? 'n/a' : `${v} ms`);
  const pctf = (v) => `${(v * 100).toFixed(1)}%`;
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    if (data.config?.mode === 'interleaved') {
      const c = data.config;
      console.log(
        `\n${c.REQUESTS} requests per side, ${Math.ceil(c.REQUESTS / c.BLOCK)} alternating blocks of ${c.BLOCK}, ${c.RPM} rpm offered, seed ${c.SEED}${c.MOCK ? ' (mock)' : ''}\n`,
      );
      console.log('| Contender | Success | 429s per request: total (per-block min–max) | 429s by limit | Refused locally | p50 / p95 latency | Cost |');
      console.log('|---|---|---|---|---|---|---|');
      for (const s of data.sides) {
        const r = s.perBlock.http429PerRequest;
        const triggers = Object.entries(s.http429ByTrigger).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
        console.log(
          `| ${s.contender} | ${pctf(s.successRate)} (${s.success}/${s.requests}) | ${s.http429PerRequest.toFixed(3)} (${r.min.toFixed(3)}–${r.max.toFixed(3)}) | ${triggers} | ${s.refusedLocally} | ${ms(s.latencyP50)} / ${ms(s.latencyP95)} | $${s.costUsd} |`,
        );
      }
    } else if (data.summary) {
      const s = data.summary;
      console.log(
        `| ${s.contender}${s.mock ? ' (mock)' : ''} (sequential) | ${pctf(s.successRate)} (${s.success}/${s.requests}) | ${s.http429} | ${s.refusedLocally} | ${ms(s.latencyP50)} / ${ms(s.latencyP95)} |`,
      );
    }
  }
}

await (SEQUENTIAL ? sequential() : interleaved());
