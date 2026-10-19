import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  adapterFor,
  geminiHeaders,
  groqHeaders,
  namedWindows,
  noHeaders,
  openaiHeaders,
  openrouterHeaders,
  parseDuration,
  parseRetryAfter,
} from '../src/headers.js';

// Synthetic fixtures with the documented header shapes; no recorded traffic.
const NOW = Date.UTC(2026, 9, 19, 12);

describe('parseDuration', () => {
  it('parses Go-style and plain durations', () => {
    expect(parseDuration('2m59.56s')).toBe(179_560);
    expect(parseDuration('7.66s')).toBe(7_660);
    expect(parseDuration('120ms')).toBe(120);
    expect(parseDuration('1h0m0s')).toBe(3_600_000);
    expect(parseDuration('1500us')).toBe(2);
    expect(parseDuration('1000000ns')).toBe(1);
    expect(parseDuration('51s')).toBe(51_000);
    expect(parseDuration('12')).toBe(12_000);
    expect(parseDuration(' 3.5 ')).toBe(3_500);
  });

  it('rejects junk', () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration('5s later')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2', NOW)).toBe(2_000);
    expect(parseRetryAfter('0.5', NOW)).toBe(500);
    expect(parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(30_000);
    expect(parseRetryAfter(new Date(NOW - 30_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter('-3', NOW)).toBe(0);
    expect(parseRetryAfter('nonsense', NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
  });
});

describe('groqHeaders', () => {
  it('maps requests to RPD and tokens to TPM', () => {
    const reading = groqHeaders(
      {
        headers: {
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '970',
          'x-ratelimit-reset-requests': '2m59.56s',
          'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '7997',
          'x-ratelimit-reset-tokens': '7.66s',
        },
      },
      NOW,
    );
    expect(reading).toEqual({
      truths: [
        { dim: 'rpd', remaining: 970, limit: 1000, resetInMs: 179_560 },
        { dim: 'tpm', remaining: 7997, limit: 8000, resetInMs: 7_660 },
      ],
    });
  });

  it('reads retry-after on a 429 and tolerates missing values', () => {
    const reading = groqHeaders(
      { status: 429, headers: { 'retry-after': '2', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': 'x' } },
      NOW,
    );
    expect(reading).toEqual({ truths: [{ dim: 'tpm', remaining: 0, resetInMs: 60_000 }], retryAfterMs: 2_000, limited: ['tpm'] });
    expect(groqHeaders({}, NOW)).toEqual({ truths: [] });
    expect(groqHeaders({ headers: { 'x-ratelimit-remaining-requests': '' } }, NOW)).toEqual({ truths: [] });
    expect(groqHeaders({ headers: { 'x-ratelimit-remaining-requests': 'abc' } }, NOW)).toEqual({ truths: [] });
  });
});

describe('openaiHeaders', () => {
  it('maps requests and tokens to per-minute windows, case-insensitively', () => {
    const reading = openaiHeaders(
      {
        headers: {
          'X-RateLimit-Remaining-Requests': '59',
          'X-RateLimit-Reset-Requests': '1s',
          'x-ratelimit-remaining-tokens': '1000',
          'retry-after-ms': '250',
        },
      },
      NOW,
    );
    expect(reading).toEqual({
      truths: [
        { dim: 'rpm', remaining: 59, resetInMs: 1_000 },
        { dim: 'tpm', remaining: 1000, resetInMs: 60_000 },
      ],
      retryAfterMs: 250,
    });
  });
});

describe('named windows in 429 bodies', () => {
  // The shape of Groq's real 429 body (organization id replaced).
  const groq429 = JSON.stringify({
    error: {
      message:
        'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_000` service tier `on_demand` on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 2s.',
      type: 'requests',
      code: 'rate_limit_exceeded',
    },
  });

  it('reads the window from Groq and OpenAI-style 429 messages', () => {
    expect(groqHeaders({ status: 429, body: groq429, headers: { 'retry-after': '2' } }, NOW)).toEqual({
      truths: [],
      retryAfterMs: 2_000,
      limited: ['rpm'],
    });
    expect(openaiHeaders({ status: 429, body: 'on tokens per min (TPM): Limit 8000 ... (TPM) and (RPD)' }, NOW).limited).toEqual(['tpm', 'rpd']);
  });

  it('ignores bodies of other statuses and messages without a named window', () => {
    expect(groqHeaders({ status: 400, body: groq429 }, NOW).limited).toBeUndefined();
    expect(groqHeaders({ status: 429, body: 'slow down' }, NOW).limited).toBeUndefined();
    expect(namedWindows(undefined)).toEqual([]);
  });
});

describe('429 sources, most reliable first', () => {
  const rpmMessage = JSON.stringify({ error: { message: 'Rate limit reached on requests per minute (RPM). Please try again in 1m2.5s.' } });

  it('wait: retry-after-ms, then retry-after, then the reset header, then the message', () => {
    const base = {
      status: 429,
      body: rpmMessage,
      headers: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '7.5s' } as Record<string, string>,
    };
    expect(openaiHeaders({ ...base, headers: { ...base.headers, 'retry-after-ms': '250', 'retry-after': '3' } }, NOW).retryAfterMs).toBe(250);
    expect(openaiHeaders({ ...base, headers: { ...base.headers, 'retry-after': '3' } }, NOW).retryAfterMs).toBe(3_000);
    expect(openaiHeaders(base, NOW).retryAfterMs).toBe(7_500);
    expect(openaiHeaders({ ...base, headers: {} }, NOW).retryAfterMs).toBe(62_500);
    expect(openaiHeaders({ status: 429, body: 'slow down' }, NOW).retryAfterMs).toBeUndefined();
  });

  it('takes the longest reset when several windows are exhausted', () => {
    const reading = groqHeaders(
      {
        status: 429,
        headers: {
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '2m0s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '5s',
        },
      },
      NOW,
    );
    expect(reading).toMatchObject({ retryAfterMs: 120_000, limited: ['rpd', 'tpm'] });
    // An exhausted window without a reset header still counts as exhausted.
    expect(groqHeaders({ status: 429, headers: { 'x-ratelimit-remaining-requests': '0' } }, NOW)).toMatchObject({ limited: ['rpd'] });
  });

  it('window: an exhausted header beats the message; the message is the fallback', () => {
    // Groq's RPM isn't in its headers (they describe RPD and TPM), so RPM comes from the message.
    expect(groqHeaders({ status: 429, body: rpmMessage, headers: { 'x-ratelimit-remaining-requests': '850' } }, NOW).limited).toEqual(['rpm']);
    expect(groqHeaders({ status: 429, body: rpmMessage, headers: { 'x-ratelimit-remaining-tokens': '0' } }, NOW).limited).toEqual(['tpm']);
  });
});

describe('openrouterHeaders', () => {
  it('treats upstream congestion as the model being busy, not as your quota', () => {
    const upstream = JSON.stringify({
      error: { message: 'google/gemma:free is temporarily rate-limited upstream.', code: 429, metadata: { provider_name: 'Example' } },
    });
    expect(openrouterHeaders({ status: 429, body: upstream }, NOW)).toEqual({ truths: [], upstream: true });
    expect(openrouterHeaders({ status: 429, body: upstream, headers: { 'retry-after': '20' } }, NOW)).toEqual({
      truths: [],
      upstream: true,
      retryAfterMs: 20_000,
    });
    expect(openrouterHeaders({ status: 429, body: 'model is temporarily rate-limited upstream' }, NOW).upstream).toBe(true);
    expect(openrouterHeaders({ status: 429, body: JSON.stringify({ error: { message: 'Rate limit exceeded' } }) }, NOW).upstream).toBeUndefined();
  });

  it('maps platform 429s to the per-minute or the shared daily window by their reset', () => {
    const platform = (resetIn: number) =>
      openrouterHeaders(
        { status: 429, headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(NOW + resetIn) } },
        NOW,
      );
    expect(platform(5 * 3_600_000)).toEqual({ truths: [], retryAfterMs: 5 * 3_600_000, limited: ['rpd'] });
    expect(platform(30_000)).toEqual({ truths: [], retryAfterMs: 30_000, limited: ['rpm'] });
  });

  it('prefers Retry-After, then the reset timestamp', () => {
    expect(openrouterHeaders({ status: 429, headers: { 'Retry-After': '10', 'X-RateLimit-Reset': String(NOW + 99_000) } }, NOW)).toEqual({
      truths: [],
      retryAfterMs: 10_000,
    });
    expect(openrouterHeaders({ status: 429, headers: { 'X-RateLimit-Reset': String(NOW + 42_000) } }, NOW)).toEqual({
      truths: [],
      retryAfterMs: 42_000,
    });
    expect(openrouterHeaders({ status: 429, headers: { 'X-RateLimit-Reset': String(NOW - 1) } }, NOW).retryAfterMs).toBe(0);
    expect(openrouterHeaders({ headers: {} }, NOW)).toEqual({ truths: [] });
  });
});

describe('geminiHeaders', () => {
  const body = (details: unknown[], wrap = false) => {
    const error = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.', details } };
    return JSON.stringify(wrap ? [error] : error);
  };

  it('reads RetryInfo and a per-day QuotaFailure', () => {
    const reading = geminiHeaders(
      {
        status: 429,
        body: body([
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '51s' },
        ]),
      },
      NOW,
    );
    expect(reading).toEqual({ truths: [], retryAfterMs: 51_000, dailyExhausted: true, limited: ['rpd'] });
  });

  it('handles array-wrapped bodies and per-minute quotas', () => {
    const reading = geminiHeaders(
      {
        body: body(
          [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }, {}] },
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
            { '@type': 'type.googleapis.com/google.rpc.Help' },
            {},
          ],
          true,
        ),
      },
      NOW,
    );
    expect(reading).toEqual({ truths: [], limited: ['rpm'] });
  });

  it('maps token quotas to token windows', () => {
    const reading = geminiHeaders(
      {
        body: body([
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              { quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier' },
              { quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier' },
              { quotaId: 'SomethingElse' },
            ],
          },
        ]),
      },
      NOW,
    );
    expect(reading).toEqual({ truths: [], dailyExhausted: true, limited: ['tpm', 'tpd'] });
  });

  it('falls back to the message text, then to retry-after', () => {
    expect(geminiHeaders({ body: 'Quota exceeded. Please retry in 51.088660108s.' }, NOW)).toEqual({
      truths: [],
      retryAfterMs: 51_089,
    });
    expect(geminiHeaders({ body: JSON.stringify({ error: { message: 'Please retry in 3s.' } }) }, NOW).retryAfterMs).toBe(3_000);
    expect(geminiHeaders({ headers: { 'retry-after': '4' }, body: 'nope' }, NOW)).toEqual({ truths: [], retryAfterMs: 4_000 });
    expect(geminiHeaders({ headers: { 'retry-after': '4' } }, NOW)).toEqual({ truths: [], retryAfterMs: 4_000 });
    expect(geminiHeaders({ body: 'null' }, NOW)).toEqual({ truths: [] });
  });
});

describe('adapterFor', () => {
  const model = (provider: string) => new MockLanguageModelV4({ provider });

  it('infers the adapter from the provider id', () => {
    expect(adapterFor({ model: model('groq.chat') })).toBe(groqHeaders);
    expect(adapterFor({ model: model('openrouter.chat') })).toBe(openrouterHeaders);
    expect(adapterFor({ model: model('google.generative-ai') })).toBe(geminiHeaders);
    expect(adapterFor({ model: model('mistral.chat') })).toBe(openaiHeaders);
  });

  it('honours an explicit choice or a custom function', () => {
    const custom = () => ({ truths: [] });
    expect(adapterFor({ model: model('groq.chat'), headers: 'none' })).toBe(noHeaders);
    expect(adapterFor({ model: model('x'), headers: custom })).toBe(custom);
    expect(noHeaders({}, NOW)).toEqual({ truths: [] });
  });
});
