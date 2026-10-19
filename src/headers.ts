import type { Dimension, HeaderAdapter, HeaderInput, HeaderReading, PoolMember, ProviderTruth } from './types.js';

const UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 0.001, µs: 0.001, ns: 0.000001 };

/** Parses Go-style durations such as `2m59.56s`, `7.66s` or `120ms`. Plain numbers are seconds. */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;
  const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(re)) {
    total += Number(match[1]) * UNITS[match[2]!]!;
    consumed += match[0].length;
  }
  return consumed > 0 && consumed === trimmed.length ? Math.ceil(total) : undefined;
}

/** `retry-after`: delay in seconds, or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function header(input: HeaderInput, name: string): string | undefined {
  const headers = input.headers;
  if (!headers) return undefined;
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function truth(
  input: HeaderInput,
  dim: ProviderTruth['dim'],
  kind: 'requests' | 'tokens',
  resetFallbackMs: number,
): ProviderTruth[] {
  const remaining = num(header(input, `x-ratelimit-remaining-${kind}`));
  if (remaining === undefined) return [];
  const limit = num(header(input, `x-ratelimit-limit-${kind}`));
  const resetInMs = parseDuration(header(input, `x-ratelimit-reset-${kind}`)) ?? resetFallbackMs;
  return [{ dim, remaining, resetInMs, ...(limit === undefined ? {} : { limit }) }];
}

function withRetryAfter(reading: HeaderReading, input: HeaderInput, now: number): HeaderReading {
  const retryAfterMs = parseRetryAfter(header(input, 'retry-after'), now);
  return retryAfterMs === undefined ? reading : { ...reading, retryAfterMs };
}

const NAMED_WINDOW = /\((RPS|RPM|RPD|TPM|TPD)\)/gi;

/**
 * Windows named in an OpenAI-style 429 message, e.g. Groq's "Rate limit reached for
 * model ... on requests per minute (RPM): Limit 30, Used 30, Requested 1".
 */
export function namedWindows(body: string | undefined): Dimension[] {
  if (!body) return [];
  return [...new Set([...body.matchAll(NAMED_WINDOW)].map((m) => m[1]!.toLowerCase() as Dimension))];
}

function withLimited(reading: HeaderReading, input: HeaderInput): HeaderReading {
  const limited = input.status === 429 ? namedWindows(input.body) : [];
  return limited.length ? { ...reading, limited } : reading;
}

/** Groq: the `requests` headers describe the daily limit, the `tokens` headers the per-minute limit. */
export const groqHeaders: HeaderAdapter = (input, now) =>
  withLimited(
    withRetryAfter(
      { truths: [...truth(input, 'rpd', 'requests', 86_400_000), ...truth(input, 'tpm', 'tokens', 60_000)] },
      input,
      now,
    ),
    input,
  );

/** OpenAI-style headers: `requests` and `tokens` both describe per-minute limits. */
export const openaiHeaders: HeaderAdapter = (input, now) => {
  const reading = withRetryAfter(
    { truths: [...truth(input, 'rpm', 'requests', 60_000), ...truth(input, 'tpm', 'tokens', 60_000)] },
    input,
    now,
  );
  const ms = num(header(input, 'retry-after-ms'));
  return withLimited(ms === undefined ? reading : { ...reading, retryAfterMs: ms }, input);
};

/**
 * OpenRouter sends rate-limit headers only on a 429: `X-RateLimit-Reset` is an epoch
 * timestamp in ms for whichever limit was hit, and `Retry-After` may be present.
 */
export const openrouterHeaders: HeaderAdapter = (input, now) => {
  const reading = withRetryAfter({ truths: [] }, input, now);
  if (reading.retryAfterMs !== undefined) return reading;
  const reset = num(header(input, 'x-ratelimit-reset'));
  return reset === undefined ? reading : { ...reading, retryAfterMs: Math.max(0, reset - now) };
};

/**
 * Gemini reports quota errors in the 429 body: a `google.rpc.RetryInfo` detail with
 * `retryDelay`, or a "retry in Ns" message, and a `QuotaFailure` naming the quota.
 */
export const geminiHeaders: HeaderAdapter = (input, now) => {
  const reading = withRetryAfter({ truths: [] }, input, now);
  if (!input.body) return reading;
  let retryAfterMs = reading.retryAfterMs;
  let dailyExhausted = false;
  const limited = new Set<Dimension>();
  try {
    const parsed: unknown = JSON.parse(input.body);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { details?: unknown[] } } | undefined;
    for (const detail of error?.error?.details ?? []) {
      const d = detail as { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string }[] };
      if (d['@type']?.endsWith('google.rpc.RetryInfo')) retryAfterMs ??= parseDuration(d.retryDelay);
      if (d['@type']?.endsWith('google.rpc.QuotaFailure')) {
        for (const v of d.violations ?? []) {
          const id = v.quotaId ?? '';
          const tokens = /Token/i.test(id);
          if (/PerDay/i.test(id)) {
            dailyExhausted = true;
            limited.add(tokens ? 'tpd' : 'rpd');
          } else if (/PerMinute/i.test(id)) {
            limited.add(tokens ? 'tpm' : 'rpm');
          }
        }
      }
    }
  } catch {
    // Not JSON: fall back to the message text below.
  }
  if (retryAfterMs === undefined) {
    const match = /retry in ([\d.]+)\s*s/i.exec(input.body);
    if (match) retryAfterMs = Math.ceil(Number(match[1]) * 1_000);
  }
  return {
    truths: [],
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(dailyExhausted ? { dailyExhausted } : {}),
    ...(limited.size ? { limited: [...limited] } : {}),
  };
};

export const noHeaders: HeaderAdapter = () => ({ truths: [] });

const ADAPTERS = { groq: groqHeaders, openai: openaiHeaders, openrouter: openrouterHeaders, gemini: geminiHeaders, none: noHeaders };

/** The member's adapter, or one inferred from the provider id (e.g. `groq.chat`, `google.generative-ai`). */
export function adapterFor(member: Pick<PoolMember, 'headers' | 'model'>): HeaderAdapter {
  if (typeof member.headers === 'function') return member.headers;
  if (member.headers) return ADAPTERS[member.headers];
  const provider = member.model.provider.toLowerCase();
  if (provider.startsWith('groq')) return groqHeaders;
  if (provider.startsWith('openrouter')) return openrouterHeaders;
  if (provider.startsWith('google')) return geminiHeaders;
  return openaiHeaders;
}
