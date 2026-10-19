import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { convertReadableStreamToArray } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeClock } from '../src/clock.js';
import { PoolExhaustedError } from '../src/errors.js';
import { createQuotaPool } from '../src/pool.js';
import { memoryStore } from '../src/store/memory.js';
import type { PoolEvent } from '../src/types.js';
import { apiError, generated, mock, silentStream, streamed, textParts, usage, userPrompt } from './helpers.js';

const T0 = Date.UTC(2026, 9, 19, 12);

function setup() {
  const clock = fakeClock(T0);
  const events: PoolEvent[] = [];
  const store = memoryStore();
  return { clock, events, store, onEvent: (e: PoolEvent) => events.push(e) };
}

const failure = (p: PromiseLike<unknown>) => Promise.resolve(p).catch((e: unknown) => e);
const types = (events: PoolEvent[]) => events.map((e) => ('memberId' in e ? `${e.type}:${e.memberId}` : e.type));

describe('createQuotaPool: generate', () => {
  it('routes to the first member and reconciles real usage', async () => {
    const s = setup();
    const a = mock('groq.chat', 'openai/gpt-oss-120b', { doGenerate: generated('hello', usage(12, 7)) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, limits: { tpm: 8_000 } }], ...s });
    const result = await generateText({ model: pool.model(), prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('hello');
    expect(types(s.events)).toEqual(['route:a', 'reconcile:a']);
    expect(s.events[1]).toMatchObject({ actualTokens: 19 });
    const snap = await pool.snapshot();
    expect(snap.members[0]).toMatchObject({ id: 'a', cooldownUntil: 0, usage: { tpm: { used: 19 } } });
  });

  it('switches on a 429 and cools the member down for retry-after', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        throw apiError(429, { headers: { 'retry-after': '7', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '7s' } });
      },
    });
    const b = mock('mistral.chat', 'y', { doGenerate: generated('from b') });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a, limits: { tpm: 8_000 } },
        { id: 'b', model: b },
      ],
      ...s,
    });
    const result = await generateText({ model: pool.model(), prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('from b');
    expect(types(s.events)).toEqual(['route:a', 'fail:a', 'cooldown:a', 'route:b', 'reconcile:b']);
    expect(s.events[2]).toMatchObject({ untilMs: T0 + 7_000 });
    const snap = await pool.snapshot();
    // The 429 was released, but the provider's truth (0 tokens left) was applied.
    expect(snap.members[0]).toMatchObject({ cooldownUntil: T0 + 7_000, usage: { tpm: { used: 8_000 } } });
  });

  it('backs off exponentially on 429s without a hint', async () => {
    const s = setup();
    const a = mock('openrouter.chat', 'm:free', {
      doGenerate: async () => {
        throw apiError(429);
      },
    });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], maxBackoffMs: 3_000, ...s });
    const untils: number[] = [];
    for (let i = 0; i < 4; i++) {
      await expect(pool.model().doGenerate({ prompt: userPrompt('x') })).rejects.toBeInstanceOf(PoolExhaustedError);
      untils.push((s.events.findLast((e) => e.type === 'cooldown') as { untilMs: number }).untilMs - s.clock.now());
      s.clock.advance(10_000);
    }
    expect(untils).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('cools down until the next Pacific midnight when Gemini reports a daily quota', async () => {
    const s = setup();
    const body = JSON.stringify({
      error: {
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      },
    });
    const g = mock('google.generative-ai', 'gemini-3.5-flash-lite', {
      doGenerate: async () => {
        throw apiError(429, { body });
      },
    });
    const r = mock('groq.chat', 'r', {
      doGenerate: async () => {
        throw apiError(429, { body });
      },
    });
    const pool = createQuotaPool({
      models: [
        { id: 'g', model: g, limits: 'gemini:free' },
        { id: 'r', model: r, limits: { rpd: 10 }, headers: 'gemini' },
      ],
      ...s,
    });
    await expect(pool.model().doGenerate({ prompt: userPrompt('x') })).rejects.toBeInstanceOf(PoolExhaustedError);
    const cooldowns = s.events.filter((e) => e.type === 'cooldown') as { memberId: string; untilMs: number }[];
    expect(cooldowns).toEqual([
      { type: 'cooldown', memberId: 'g', untilMs: Date.UTC(2026, 9, 20, 7) },
      // A rolling daily limit waits a full day.
      { type: 'cooldown', memberId: 'r', untilMs: T0 + 86_400_000 },
    ]);
  });

  it('rethrows validation errors without trying other members', async () => {
    const s = setup();
    const bad = apiError(400);
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        throw bad;
      },
    });
    const b = mock('groq.chat', 'y', { doGenerate: generated('never') });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, limits: { rpm: 5 } }, { id: 'b', model: b }], ...s });
    await expect(pool.model().doGenerate({ prompt: userPrompt('x') })).rejects.toBe(bad);
    expect(b.doGenerateCalls).toHaveLength(0);
    // The request reached the provider, so it still counts.
    expect((await pool.snapshot()).members[0]!.usage.rpm?.used).toBe(1);
  });

  it('counts a 5xx against quota but gives back a request that never left', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        throw apiError(503);
      },
    });
    const b = mock('groq.chat', 'y', {
      doGenerate: async () => {
        throw apiError(undefined);
      },
    });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a, limits: { rpm: 5 } },
        { id: 'b', model: b, limits: { rpm: 5 } },
      ],
      failureCooldownMs: 2_000,
      ...s,
    });
    const error = await failure(pool.model().doGenerate({ prompt: userPrompt('x') }));
    expect(error).toBeInstanceOf(PoolExhaustedError);
    expect((error as PoolExhaustedError).failures).toEqual([
      { memberId: 'a', reason: 'retryable' },
      { memberId: 'b', reason: 'retryable' },
    ]);
    expect((error as PoolExhaustedError).retryAfterMs).toBeUndefined();
    const snap = await pool.snapshot();
    expect(snap.members.map((m) => m.usage.rpm?.used)).toEqual([1, 0]);
    expect(snap.members.map((m) => m.cooldownUntil)).toEqual([T0 + 2_000, T0 + 2_000]);
  });

  it('skips members without quota and reports the soonest retry', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doGenerate: generated('a') });
    const b = mock('groq.chat', 'y', { doGenerate: generated('b') });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a, limits: { rpm: 1 } },
        { id: 'b', model: b, limits: { rpm: 1, tpm: 10 } },
      ],
      ...s,
    });
    const m = pool.model();
    expect((await generateText({ model: m, prompt: 'hi', maxRetries: 0 })).text).toBe('a');
    s.clock.advance(30_000);
    // b's 10 TPM can never hold a 512-token estimate.
    const error = await failure(generateText({ model: m, prompt: 'hi', maxRetries: 0 }));
    expect(error).toBeInstanceOf(PoolExhaustedError);
    expect((error as PoolExhaustedError).failures).toEqual([
      { memberId: 'a', reason: 'quota', retryAfterMs: 31_000 },
      { memberId: 'b', reason: 'never-fits' },
    ]);
    expect((error as PoolExhaustedError).retryAfterMs).toBe(31_000);
  });

  it('applies provider headers from a successful call', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doGenerate: generated('a', usage(1, 1), {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '1h0m0s',
      }),
    });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, limits: { rpd: 1_000 } }], ...s });
    await pool.model().doGenerate({ prompt: userPrompt('x') });
    const error = (await failure(pool.model().doGenerate({ prompt: userPrompt('x') }))) as PoolExhaustedError;
    expect(error.failures).toEqual([{ memberId: 'a', reason: 'quota', retryAfterMs: 3_600_000 }]);
  });

  it('rethrows when the caller aborts', async () => {
    const s = setup();
    const ctl = new AbortController();
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        ctl.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    const b = mock('groq.chat', 'y', { doGenerate: generated('b') });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }, { id: 'b', model: b }], ...s });
    await expect(pool.model().doGenerate({ prompt: userPrompt('x'), abortSignal: ctl.signal })).rejects.toThrow('aborted');
    expect(b.doGenerateCalls).toHaveLength(0);
  });

  it('forwards an already-aborted caller signal to the member', async () => {
    const s = setup();
    const ctl = new AbortController();
    ctl.abort();
    let seen: boolean | undefined;
    const a = mock('groq.chat', 'x', {
      doGenerate: async (o) => {
        seen = o.abortSignal?.aborted;
        return generated('a');
      },
    });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], ...s });
    await pool.model().doGenerate({ prompt: userPrompt('x'), abortSignal: ctl.signal });
    expect(seen).toBe(true);
  });

  it('requires tool support when the call has tools, and honours require/exclude', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doGenerate: generated('a') });
    const b = mock('groq.chat', 'y', { doGenerate: generated('b') });
    const c = mock('google.generative-ai', 'z', { doGenerate: generated('c') });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a, capabilities: { tools: false, json: false } },
        { id: 'c', model: c, tags: ['may-train'] },
        { id: 'b', model: b },
      ],
      ...s,
    });
    const result = await generateText({
      model: pool.model({ exclude: ['may-train'] }),
      prompt: 'hi',
      maxRetries: 0,
      tools: { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) },
    });
    expect(result.text).toBe('b');
    expect(types(s.events).slice(0, 2)).toEqual(['skip:a', 'skip:c']);
    const json = await pool.model({ require: ['json', 'tools'] }).doGenerate({ prompt: userPrompt('x'), tools: [] });
    expect(json.content).toEqual([{ type: 'text', text: 'c' }]);
  });

  it('charges every member of a shared group: three free models share one daily cap', async () => {
    const s = setup();
    const ids = ['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free', 'other/model:free'];
    const pool = createQuotaPool({
      models: ids.map((id, i) => ({ id: `or${i}`, model: mock('openrouter.chat', id, { doGenerate: generated(id) }), limits: 'openrouter:free' })),
      groups: { 'openrouter:free-daily': { rpd: 4, dailyReset: { timeZone: 'UTC' } } },
      strategy: 'most-headroom',
      ...s,
    });
    for (let i = 0; i < 4; i++) {
      await pool.model().doGenerate({ prompt: userPrompt('x') });
      s.clock.advance(1_000);
    }
    const error = (await failure(pool.model().doGenerate({ prompt: userPrompt('x') }))) as PoolExhaustedError;
    expect(error.failures.map((f) => f.reason)).toEqual(['quota', 'quota', 'quota']);
    // Free again at the next UTC midnight.
    expect(error.retryAfterMs).toBe(Date.UTC(2026, 9, 20) - s.clock.now());
    const snap = await pool.snapshot();
    expect(snap.groups).toEqual([
      { id: 'openrouter:free-daily', usage: { rpd: { used: 4, limit: 4, remaining: 0, resetInMs: Date.UTC(2026, 9, 20) - s.clock.now() } } },
    ]);
  });

  it('enforces per-key budgets on top of provider limits', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doGenerate: generated('a') });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], budgets: { perKey: { rpd: 1 } }, ...s });
    await pool.model({ budgetKey: 'tenant-1' }).doGenerate({ prompt: userPrompt('x') });
    expect((await pool.remaining('tenant-1')).rpd).toMatchObject({ used: 1, limit: 1, remaining: 0 });
    expect((await pool.remaining('tenant-2')).rpd).toMatchObject({ used: 0, remaining: 1 });
    await expect(pool.model({ budgetKey: 'tenant-1' }).doGenerate({ prompt: userPrompt('x') })).rejects.toBeInstanceOf(PoolExhaustedError);
    await pool.model({ budgetKey: 'tenant-2' }).doGenerate({ prompt: userPrompt('x') });
    await pool.model().doGenerate({ prompt: userPrompt('x') });
    // No perKey limits configured: budget keys are ignored.
    const open = createQuotaPool({ models: [{ id: 'a', model: a }], ...setup() });
    await open.model({ budgetKey: 'k' }).doGenerate({ prompt: userPrompt('x') });
    expect(await open.remaining('k')).toEqual({});
  });

  it('keeps a conversation on its member while it has quota (sticky)', async () => {
    const s = setup();
    let aFails = true;
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        if (aFails) throw apiError(429, { headers: { 'retry-after': '1' } });
        return generated('a');
      },
    });
    const b = mock('mistral.chat', 'y', { doGenerate: generated('b') });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a },
        { id: 'b', model: b, limits: { rpd: 2 } },
      ],
      ...s,
    });
    const chat = pool.model({ stickyKey: 'conv-1' });
    const text = async () => ((await chat.doGenerate({ prompt: userPrompt('x') })).content[0] as { text: string }).text;
    expect(await text()).toBe('b');
    aFails = false;
    s.clock.advance(5_000);
    // a is healthy again, but the conversation stays on b...
    expect(await text()).toBe('b');
    // ...until b runs out.
    expect(await text()).toBe('a');
    // A different conversation uses normal priority.
    const other = await pool.model({ stickyKey: 'conv-2' }).doGenerate({ prompt: userPrompt('x') });
    expect(other.content).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('can leave foreign provider data in place', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doGenerate: generated('a') });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], stripForeignProviderData: false, ...s });
    const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x' }], providerOptions: { google: { z: 1 } } }];
    await pool.model().doGenerate({ prompt });
    expect(a.doGenerateCalls[0]!.prompt).toEqual(prompt);
  });

  it('keeps the estimate when the provider reports no usage', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doGenerate: generated('a', usage(undefined, undefined)) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, limits: { tpm: 8_000 } }], expectedOutputTokens: 100, ...s });
    await pool.model().doGenerate({ prompt: userPrompt('abcdefg') });
    expect(s.events.at(-1)).toMatchObject({ type: 'reconcile', estimatedTokens: 102, actualTokens: undefined });
    expect((await pool.snapshot()).members[0]!.usage.tpm?.used).toBe(102);
    const b = mock('groq.chat', 'y', { doGenerate: generated('b', usage(undefined, 9)) });
    const p2 = createQuotaPool({ models: [{ id: 'b', model: b }], ...s });
    await p2.model().doGenerate({ prompt: userPrompt('x') });
    expect(s.events.at(-1)).toMatchObject({ actualTokens: 9 });
    const c = mock('groq.chat', 'z', { doGenerate: generated('c', usage(6, undefined)) });
    const p3 = createQuotaPool({ models: [{ id: 'c', model: c }], ...s });
    await p3.model().doGenerate({ prompt: userPrompt('x') });
    expect(s.events.at(-1)).toMatchObject({ actualTokens: 6 });
  });

  it('reports cooling-down members with their wait', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doGenerate: async () => {
        throw apiError(429, { headers: { 'retry-after': '9' } });
      },
    });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], ...s });
    await expect(pool.model().doGenerate({ prompt: userPrompt('x') })).rejects.toBeInstanceOf(PoolExhaustedError);
    s.clock.advance(4_000);
    const error = (await failure(pool.model().doGenerate({ prompt: userPrompt('x') }))) as PoolExhaustedError;
    expect(error.failures).toEqual([{ memberId: 'a', reason: 'cooldown', retryAfterMs: 5_000 }]);
    expect(error.retryAfterMs).toBe(5_000);
  });
});

describe('createQuotaPool: stream', () => {
  it('switches when a member fails before its first chunk, with no duplicated text', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doStream: streamed([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'error', error: apiError(503) }]),
    });
    const b = mock('mistral.chat', 'y', { doStream: streamed(textParts('only b', usage(4, 3))) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }, { id: 'b', model: b }], ...s });
    const result = streamText({ model: pool.model(), prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('only b');
    expect(types(s.events)).toEqual(['route:a', 'fail:a', 'cooldown:a', 'route:b', 'reconcile:b']);
  });

  it('switches when doStream itself throws a 429', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doStream: async () => {
        throw apiError(429, { headers: { 'retry-after': '3' } });
      },
    });
    const b = mock('mistral.chat', 'y', { doStream: streamed(textParts('b')) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }, { id: 'b', model: b }], ...s });
    expect(await streamText({ model: pool.model(), prompt: 'hi', maxRetries: 0 }).text).toBe('b');
  });

  it('does not switch after the first chunk: a mid-stream error reaches the caller', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', {
      doStream: streamed([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'partial ' },
        { type: 'error', error: new Error('mid-stream') },
      ]),
    });
    const b = mock('mistral.chat', 'y', { doStream: streamed(textParts('b')) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }, { id: 'b', model: b }], ...s });
    const errors: unknown[] = [];
    const result = streamText({ model: pool.model(), prompt: 'hi', maxRetries: 0, onError: ({ error }) => void errors.push(error) });
    const text = await Promise.resolve(result.text).catch(() => 'rejected');
    expect(['partial ', 'rejected']).toContain(text);
    expect(b.doStreamCalls).toHaveLength(0);
    expect(errors.length + (text === 'rejected' ? 1 : 0)).toBeGreaterThan(0);
  });

  it('times out a member that never sends a first chunk, but waits on the last one', async () => {
    const s = setup();
    const a = mock('groq.chat', 'x', { doStream: async () => ({ stream: silentStream() }) });
    const hang = mock('groq.chat', 'h', { doStream: () => new Promise(() => {}) });
    const b = mock('mistral.chat', 'y', { doStream: streamed(textParts('b')) });
    const pool = createQuotaPool({
      models: [
        { id: 'a', model: a },
        { id: 'hang', model: hang },
        { id: 'b', model: b },
      ],
      firstTokenTimeoutMs: 20,
      ...s,
    });
    const r = await pool.model().doStream({ prompt: userPrompt('x') });
    const parts = await convertReadableStreamToArray(r.stream);
    expect(parts.filter((p) => p.type === 'text-delta')).toEqual([{ type: 'text-delta', id: 't', delta: 'b' }]);
    expect(types(s.events).filter((t) => t.startsWith('fail'))).toEqual(['fail:a', 'fail:hang']);
    expect((s.events.find((e) => e.type === 'fail') as { error: Error }).error.name).toBe('FirstTokenTimeoutError');
  });

  it('commits the estimate once when the consumer cancels mid-stream', async () => {
    const s = setup();
    let sent = 0;
    const endless = new ReadableStream<LanguageModelV4StreamPart>({
      pull(c) {
        c.enqueue({ type: 'text-delta', id: 't', delta: `chunk${sent++} ` });
      },
    });
    const a = mock('groq.chat', 'x', { doStream: async () => ({ stream: endless }) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, limits: { tpm: 8_000 } }], expectedOutputTokens: 100, ...s });
    const r = await pool.model().doStream({ prompt: userPrompt('x') });
    const reader = r.stream.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel('tab closed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconciles = s.events.filter((e) => e.type === 'reconcile');
    expect(reconciles).toEqual([{ type: 'reconcile', memberId: 'a', estimatedTokens: 101, actualTokens: undefined }]);
    expect((await pool.snapshot()).members[0]!.usage.tpm?.used).toBe(101);
  });

  it('reports a store failure when recording a finished stream', async () => {
    const s = setup();
    const broken = { ...s.store, commit: async () => Promise.reject(new Error('store down')) };
    const a = mock('groq.chat', 'x', { doStream: streamed(textParts('hi')) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], ...s, store: broken });
    const r = await pool.model().doStream({ prompt: userPrompt('x') });
    await convertReadableStreamToArray(r.stream);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.events.at(-1)).toMatchObject({ type: 'store-error', memberId: 'a', error: new Error('store down') });
  });

  it('rethrows at once when the caller already aborted', async () => {
    const s = setup();
    const ctl = new AbortController();
    ctl.abort(new Error('gone'));
    const a = mock('groq.chat', 'x', { doStream: () => new Promise(() => {}) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }], ...s });
    await expect(pool.model().doStream({ prompt: userPrompt('x'), abortSignal: ctl.signal })).rejects.toThrow('gone');
  });

  it('rethrows when the caller aborts while waiting for the first chunk', async () => {
    const s = setup();
    const ctl = new AbortController();
    const a = mock('groq.chat', 'x', { doStream: async () => ({ stream: silentStream() }) });
    const b = mock('mistral.chat', 'y', { doStream: streamed(textParts('b')) });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a }, { id: 'b', model: b }], ...s });
    const pending = pool.model().doStream({ prompt: userPrompt('x'), abortSignal: ctl.signal });
    setTimeout(() => ctl.abort(new Error('user left')), 5);
    await expect(pending).rejects.toThrow('user left');
    expect(b.doStreamCalls).toHaveLength(0);
  });

  it('switches members in the middle of a tool loop, keeping tool-call ids', async () => {
    const s = setup();
    let aCalls = 0;
    const a = mock('google.generative-ai', 'gemini-3.5-flash-lite', {
      doStream: async () => {
        if (aCalls++ > 0) throw apiError(429, { headers: { 'retry-after': '60' } });
        return streamed([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call_42',
            toolName: 'weather',
            input: JSON.stringify({ city: 'Cairo' }),
            providerMetadata: { google: { thoughtSignature: 'sig' } },
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'STOP' }, usage: usage(20, 5) },
        ]);
      },
    });
    const b = mock('groq.chat', 'openai/gpt-oss-120b', { doStream: streamed(textParts('It is 31°C in Cairo.')) });
    const pool = createQuotaPool({ models: [{ id: 'gemini', model: a }, { id: 'groq', model: b }], ...s });
    const result = streamText({
      model: pool.model(),
      prompt: 'Weather in Cairo?',
      maxRetries: 0,
      stopWhen: stepCountIs(3),
      tools: {
        weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => ({ city, c: 31 }) }),
      },
    });
    expect(await result.text).toBe('It is 31°C in Cairo.');
    const sent: LanguageModelV4CallOptions = b.doStreamCalls[0]!;
    const assistant = sent.prompt.find((m) => m.role === 'assistant')!;
    const toolMsg = sent.prompt.find((m) => m.role === 'tool')!;
    expect(assistant.content).toEqual([
      { type: 'tool-call', toolCallId: 'call_42', toolName: 'weather', input: { city: 'Cairo' } },
    ]);
    expect(toolMsg.content).toEqual([
      expect.objectContaining({ type: 'tool-result', toolCallId: 'call_42', toolName: 'weather', output: { type: 'json', value: { city: 'Cairo', c: 31 } } }),
    ]);
    expect(JSON.stringify(sent.prompt)).not.toContain('thoughtSignature');
  });
});

describe('createQuotaPool: configuration', () => {
  const m = mock('groq.chat', 'openai/gpt-oss-120b');

  it('resolves registry limits and reports its shape', () => {
    const pool = createQuotaPool({ models: [{ id: 'a', model: m, limits: 'groq:free' }, { id: 'b', model: m }] });
    const model = pool.model();
    expect(model).toMatchObject({ specificationVersion: 'v4', provider: 'ai-sdk-quota', modelId: 'a|b', supportedUrls: {} });
  });

  it('rejects bad configuration', () => {
    expect(() => createQuotaPool({ models: [] })).toThrow('empty');
    expect(() => createQuotaPool({ models: [{ id: 'a', model: m }, { id: 'a', model: m }] })).toThrow('duplicate');
    expect(() => createQuotaPool({ models: [{ id: 'a', model: m, limits: 'groq:paid' }] })).toThrow('no registry limits');
    expect(() => createQuotaPool({ models: [{ id: 'a', model: m, groups: ['mystery'] }] })).toThrow('no limits for group');
  });

  it('uses the defaults: memory store, system clock, Math.random', async () => {
    const a = mock('groq.chat', 'x', { doGenerate: generated('ok') });
    const pool = createQuotaPool({ models: [{ id: 'a', model: a, groups: ['openrouter:free-daily'] }], strategy: 'weighted' });
    await pool.model().doGenerate({ prompt: userPrompt('x') });
    expect((await pool.snapshot()).groups[0]!.usage.rpd?.used).toBe(1);
  });
});
