import { groqHeaders, openaiHeaders } from './headers.js';
import type { HeaderAdapter, Limits, ProviderTruth } from './types.js';

export interface ProbePreset {
  baseURL: string;
  keyEnv: string;
  model: string;
  adapter: HeaderAdapter;
}

/** OpenAI-compatible chat endpoints whose responses carry rate-limit headers. */
export const PROBE_PRESETS: Record<string, ProbePreset> = {
  groq: { baseURL: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', model: 'openai/gpt-oss-20b', adapter: groqHeaders },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', model: 'gpt-oss-120b', adapter: openaiHeaders },
  mistral: { baseURL: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', model: 'mistral-small-latest', adapter: openaiHeaders },
};

export interface ProbeReport {
  provider: string;
  model?: string;
  /** Limits read from the response, ready to paste into a pool member. */
  limits: Limits;
  truths: ProviderTruth[];
  /** Rate-limit related headers as received (names and values only; never the key). */
  headers: Record<string, string>;
  notes: string[];
}

export interface ProbeOptions {
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const RATE_HEADER = /ratelimit|retry-after/i;

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (RATE_HEADER.test(name)) out[name.toLowerCase()] = value;
  });
  return out;
}

/**
 * Sends one tiny request with your key and reads what the provider says your limits
 * are. Limits differ by account and change often; this shows the real ones.
 */
export async function probe(options: ProbeOptions): Promise<ProbeReport> {
  const doFetch = options.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${options.apiKey}` };

  if (options.provider === 'openrouter') {
    const res = await doFetch('https://openrouter.ai/api/v1/key', { headers: auth });
    if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);
    type Daily = { used: number; limit: number; remaining: number };
    const body = (await res.json()) as { data?: { free_model_daily_requests?: Daily }; free_model_daily_requests?: Daily };
    const daily = body.data?.free_model_daily_requests ?? body.free_model_daily_requests;
    return {
      provider: 'openrouter',
      limits: { rpm: 20 },
      truths: daily ? [{ dim: 'rpd', remaining: daily.remaining, limit: daily.limit, resetInMs: 0 }] : [],
      headers: {},
      notes: [
        daily
          ? `Free-model daily requests: ${daily.used} used of ${daily.limit} (UTC day). Set groups: { 'openrouter:free-daily': { rpd: ${daily.limit}, dailyReset: { timeZone: 'UTC' } } }.`
          : 'This key reported no free-model daily counter.',
        'The per-minute limit (20 RPM for :free models) is not reported by the API.',
      ],
    };
  }

  if (options.provider === 'gemini') {
    return {
      provider: 'gemini',
      limits: {},
      truths: [],
      headers: {},
      notes: [
        'Gemini does not send rate-limit headers. Your limits are per project and per model:',
        'open AI Studio (aistudio.google.com) > your project > rate limits, and copy RPM / TPM / RPD.',
        "Use dailyReset: { timeZone: 'America/Los_Angeles' } (RPD resets at midnight Pacific).",
      ],
    };
  }

  const preset = PROBE_PRESETS[options.provider];
  if (!preset && !options.baseURL) {
    throw new Error(`Unknown provider "${options.provider}". Use one of: groq, cerebras, mistral, openrouter, gemini, or pass --base-url.`);
  }
  const baseURL = (options.baseURL ?? preset!.baseURL).replace(/\/+$/, '');
  const model = options.model ?? preset?.model;
  if (!model) throw new Error('Pass --model for a custom --base-url.');
  const res = await doFetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  });
  const headers = pickHeaders(res.headers);
  const adapter = preset?.adapter ?? openaiHeaders;
  const reading = adapter({ headers, status: res.status }, Date.now());
  const limits: Limits = {};
  for (const t of reading.truths) if (t.limit !== undefined) limits[t.dim] = t.limit;
  const notes: string[] = [];
  if (!res.ok) notes.push(`The request failed with HTTP ${res.status}; headers may still describe your limits.`);
  if (!Object.keys(headers).length) notes.push('The response had no rate-limit headers.');
  if (reading.retryAfterMs !== undefined) notes.push(`The provider asked to retry after ${Math.ceil(reading.retryAfterMs / 1000)}s.`);
  return { provider: options.provider, model, limits, truths: reading.truths, headers, notes };
}

export function formatReport(report: ProbeReport): string {
  const lines = [`Provider: ${report.provider}${report.model ? `, model ${report.model}` : ''}`];
  for (const t of report.truths) {
    const reset = t.resetInMs ? `, resets in ${Math.ceil(t.resetInMs / 1000)}s` : '';
    lines.push(`  ${t.dim}: ${t.remaining} remaining${t.limit === undefined ? '' : ` of ${t.limit}`}${reset}`);
  }
  if (Object.keys(report.headers).length) {
    lines.push('Headers:');
    for (const [name, value] of Object.entries(report.headers)) lines.push(`  ${name}: ${value}`);
  }
  if (Object.keys(report.limits).length) lines.push(`Config: limits: ${JSON.stringify(report.limits)}`);
  for (const note of report.notes) lines.push(note);
  return lines.join('\n');
}

export interface CliIo {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  fetch?: typeof fetch;
}

const KEY_ENV: Record<string, string> = { openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY' };

/** `ai-sdk-quota probe --provider groq [--model id] [--base-url url] [--key-env NAME] [--json]`. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(arg.slice(2), 'true');
    else flags.set(arg.slice(2), rest[++i]!);
  }
  if (command !== 'probe' || !flags.has('provider')) {
    io.log('Usage: ai-sdk-quota probe --provider <groq|cerebras|mistral|openrouter|gemini> [--model id] [--base-url url] [--key-env NAME] [--json]');
    io.log('The API key is read from an environment variable (e.g. GROQ_API_KEY), never from the command line.');
    return command === undefined || command === 'help' || flags.has('help') ? 0 : 1;
  }
  const provider = flags.get('provider')!;
  const keyEnv = flags.get('key-env') ?? PROBE_PRESETS[provider]?.keyEnv ?? KEY_ENV[provider] ?? 'API_KEY';
  const apiKey = io.env[keyEnv];
  if (!apiKey && provider !== 'gemini') {
    io.log(`Set ${keyEnv} to your ${provider} API key first.`);
    return 1;
  }
  try {
    const model = flags.get('model');
    const baseURL = flags.get('base-url');
    const report = await probe({
      provider,
      apiKey: apiKey ?? '',
      ...(model === undefined ? {} : { model }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    io.log(flags.has('json') ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (error) {
    io.log(`Probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
