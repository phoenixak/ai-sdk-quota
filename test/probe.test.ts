import { describe, expect, it } from 'vitest';
import { formatReport, probe, runCli } from '../src/probe.js';

// Synthetic responses with the documented header shapes.
function fakeFetch(status: number, headers: Record<string, string>, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const groqHeaders = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '998',
  'x-ratelimit-reset-requests': '2m52.8s',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-tokens': '7990',
  'x-ratelimit-reset-tokens': '75ms',
  'x-request-id': 'req_000',
};

describe('probe', () => {
  it('reads Groq limits from one tiny request', async () => {
    const f = fakeFetch(200, groqHeaders);
    const report = await probe({ provider: 'groq', apiKey: 'gsk_test', fetch: f.fn });
    expect(report.limits).toEqual({ rpd: 1000, tpm: 8000 });
    expect(report.headers).not.toHaveProperty('x-request-id');
    expect(f.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(String(f.calls[0]!.init!.body))).toEqual({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    const text = formatReport(report);
    expect(text).toContain('rpd: 998 remaining of 1000, resets in 173s');
    expect(text).toContain('Config: limits: {"rpd":1000,"tpm":8000}');
    expect(text).not.toContain('gsk_test');
  });

  it('reports failures, missing headers and retry hints', async () => {
    const limited = await probe({
      provider: 'mistral',
      apiKey: 'k',
      fetch: fakeFetch(429, { 'retry-after': '3', 'x-ratelimit-remaining-tokens': '0' }).fn,
    });
    expect(limited.notes).toEqual([
      'The request failed with HTTP 429; headers may still describe your limits.',
      'The provider asked to retry after 3s.',
    ]);
    expect(limited.limits).toEqual({});
    expect(formatReport(limited)).toContain('  tpm: 0 remaining, resets in 60s');
    const bare = await probe({ provider: 'custom', baseURL: 'https://llm.example.com/v1/', model: 'm', apiKey: 'k', fetch: fakeFetch(200, {}).fn });
    expect(bare.notes).toEqual(['The response had no rate-limit headers.']);
    expect(formatReport({ ...bare, model: undefined } as never)).toBe('Provider: custom\nThe response had no rate-limit headers.');
  });

  it('reads the OpenRouter free-model daily counter', async () => {
    const f = fakeFetch(200, {}, { data: { free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } });
    const report = await probe({ provider: 'openrouter', apiKey: 'k', fetch: f.fn });
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/key');
    expect(report.truths).toEqual([{ dim: 'rpd', remaining: 47, limit: 50, resetInMs: 0 }]);
    expect(report.notes[0]).toContain("rpd: 50, dailyReset: { timeZone: 'UTC' }");
    expect(formatReport(report)).toContain('rpd: 47 remaining of 50');
    const flat = await probe({ provider: 'openrouter', apiKey: 'k', fetch: fakeFetch(200, {}, { free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } }).fn });
    expect(flat.truths[0]!.limit).toBe(1000);
    const none = await probe({ provider: 'openrouter', apiKey: 'k', fetch: fakeFetch(200, {}, {}).fn });
    expect(none.notes[0]).toBe('This key reported no free-model daily counter.');
    await expect(probe({ provider: 'openrouter', apiKey: 'k', fetch: fakeFetch(401, {}).fn })).rejects.toThrow('HTTP 401');
  });

  it('explains Gemini instead of sending a request', async () => {
    const f = fakeFetch(200, {});
    const report = await probe({ provider: 'gemini', apiKey: '', fetch: f.fn });
    expect(f.calls).toHaveLength(0);
    expect(report.notes.join(' ')).toContain('AI Studio');
  });

  it('rejects unknown providers and custom URLs without a model', async () => {
    await expect(probe({ provider: 'acme', apiKey: 'k' })).rejects.toThrow('Unknown provider');
    await expect(probe({ provider: 'acme', baseURL: 'https://x.example.com', apiKey: 'k' })).rejects.toThrow('--model');
  });

  it('uses the global fetch by default', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(200, groqHeaders).fn;
    try {
      expect((await probe({ provider: 'groq', apiKey: 'k' })).limits.rpd).toBe(1000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('runCli', () => {
  const run = async (argv: string[], env: Record<string, string> = {}, fetch?: typeof globalThis.fetch) => {
    const lines: string[] = [];
    const code = await runCli(argv, { env, log: (l) => lines.push(l), ...(fetch ? { fetch } : {}) });
    return { code, out: lines.join('\n') };
  };

  it('prints usage', async () => {
    expect((await run([])).code).toBe(0);
    expect((await run(['help'])).out).toContain('Usage');
    expect((await run(['probe', '--help'])).code).toBe(0);
    expect((await run(['probe'])).code).toBe(1);
    expect((await run(['other', '--provider', 'groq'])).code).toBe(1);
    expect((await run(['probe', 'stray', '--provider', 'gemini'])).code).toBe(0);
  });

  it('reads the key from the environment and prints the report or JSON', async () => {
    expect(await run(['probe', '--provider', 'groq'])).toEqual({ code: 1, out: 'Set GROQ_API_KEY to your groq API key first.' });
    const ok = await run(['probe', '--provider', 'groq', '--model', 'openai/gpt-oss-120b'], { GROQ_API_KEY: 'k' }, fakeFetch(200, groqHeaders).fn);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('model openai/gpt-oss-120b');
    const json = await run(['probe', '--provider', 'custom', '--base-url', 'https://x.example.com', '--model', 'm', '--key-env', 'MY_KEY', '--json'], { MY_KEY: 'k' }, fakeFetch(200, groqHeaders).fn);
    expect(JSON.parse(json.out).limits).toEqual({ rpm: 1000, tpm: 8000 });
    expect((await run(['probe', '--provider', 'gemini'])).out).toContain('AI Studio');
    expect((await run(['probe', '--provider', 'openrouter'], {})).out).toBe('Set OPENROUTER_API_KEY to your openrouter API key first.');
    expect((await run(['probe', '--provider', 'acme'], { API_KEY: 'k' })).out).toContain('Probe failed: Unknown provider');
    const thrown = (async () => Promise.reject('offline')) as unknown as typeof fetch;
    expect((await run(['probe', '--provider', 'groq'], { GROQ_API_KEY: 'k' }, thrown)).out).toBe('Probe failed: offline');
  });
});
