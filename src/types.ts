import type { LanguageModelV4 } from '@ai-sdk/provider';

/** Rate-limit windows: requests per second/minute/day, tokens per minute/day. */
export type Dimension = 'rps' | 'rpm' | 'rpd' | 'tpm' | 'tpd';

/**
 * How daily windows (rpd, tpd) reset: a rolling 24 hours, or at local midnight
 * in an IANA time zone (e.g. Gemini resets at midnight `America/Los_Angeles`).
 */
export type DailyReset = 'rolling' | { timeZone: string };

export interface Limits {
  rps?: number;
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  /** Defaults to `'rolling'`. */
  dailyReset?: DailyReset;
}

export interface Capabilities {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
}

export interface Clock {
  now(): number;
}

/** What a provider's response headers or error body say about its limits. */
export interface ProviderTruth {
  dim: Dimension;
  remaining: number;
  limit?: number;
  resetInMs: number;
  /**
   * The provider rejected a call because this window is full. Instead of holding the
   * reading until `resetInMs`, assume the provider's usage drains evenly until then.
   */
  drain?: boolean;
}

export interface HeaderReading {
  truths: ProviderTruth[];
  /** How long the provider asked us to wait (from `retry-after` or an error body). */
  retryAfterMs?: number;
  /** The provider said a daily quota is used up. */
  dailyExhausted?: boolean;
  /** Windows the provider named in a 429 ("on requests per minute (RPM)", a per-day quota, ...). */
  limited?: Dimension[];
}

export interface HeaderInput {
  headers?: Record<string, string | undefined> | undefined;
  /** HTTP status of a failed call. */
  status?: number | undefined;
  /** Raw body of a failed call. */
  body?: string | undefined;
}

export type HeaderAdapter = (input: HeaderInput, now: number) => HeaderReading;

export type SkipReason = 'cooldown' | 'quota' | 'capability' | 'excluded' | 'never-fits';

export type PoolEvent =
  | { type: 'route'; memberId: string; attempt: number; estimatedTokens: number }
  | { type: 'skip'; memberId: string; reason: SkipReason; retryAfterMs?: number }
  | { type: 'fail'; memberId: string; kind: 'rate-limit' | 'retryable'; error: unknown }
  | { type: 'cooldown'; memberId: string; untilMs: number }
  | { type: 'exhausted'; retryAfterMs: number | undefined }
  | { type: 'reconcile'; memberId: string; estimatedTokens: number; actualTokens: number | undefined }
  /** Recording a finished stream's usage failed; nothing else can surface it. */
  | { type: 'store-error'; memberId: string; error: unknown }
  /** A named 429 lowered a member's effective limit for one window (see `adaptive`). */
  | { type: 'adapt'; memberId: string; dim: Dimension; factor: number };

export interface PoolMember {
  /** Stable id used for store keys, events and stickiness. */
  id: string;
  model: LanguageModelV4;
  /** Explicit limits, or a registry id such as `'groq:free'` (resolved by the model id). */
  limits?: Limits | string;
  /** Shared buckets this member also charges, e.g. `'openrouter:free-daily'`. */
  groups?: string[];
  tags?: string[];
  /** Missing capabilities are assumed to be supported. */
  capabilities?: Capabilities;
  /** Relative weight for the `'weighted'` strategy. Defaults to 1. */
  weight?: number;
  /** Which header adapter reads this member's responses. Inferred from the provider by default. */
  headers?: 'groq' | 'openai' | 'openrouter' | 'gemini' | 'none' | HeaderAdapter;
}
