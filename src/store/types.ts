import type { DailyReset, Dimension, Limits, ProviderTruth } from '../types.js';
import type { AdaptOptions } from './adaptive.js';

/** One bucket of capacity a call charges: a pool member, a shared group, or a budget key. */
export interface Charge {
  key: string;
  limits: Limits;
  /** Requests this call counts against rps/rpm/rpd (normally 1). */
  requests: number;
  /** Tokens this call is expected to use in total, counted against tpm/tpd. */
  tokens: number;
  /** Expected prompt tokens, counted against itpm. Defaults to `tokens`. */
  inputTokens?: number;
  /** Expected completion tokens, counted against otpm. Defaults to `tokens`. */
  outputTokens?: number;
}

/** Real usage after a call; any count may be unknown. A plain number means the total. */
export type ActualTokens = number | { total?: number | undefined; input?: number | undefined; output?: number | undefined };

/** Where a reservation put each amount, so commit and release can adjust the same buckets. */
export interface Placement {
  key: string;
  dim: Dimension;
  bucket: number;
  amount: number;
  /** Set when the window resets at local midnight, so a late commit can find today's bucket. */
  dailyReset?: DailyReset;
}

export interface Reservation {
  id: string;
  placements: Placement[];
  /** After this time an uncommitted reservation is released automatically. */
  expiresAt: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; retryAfterMs: number; blocked: { key: string; dim: Dimension } };

export interface WindowUsage {
  used: number;
  limit: number;
  remaining: number;
  resetInMs: number;
}

export type Usage = Partial<Record<Dimension, WindowUsage>>;

/**
 * Shared state for a pool. Every method must be atomic with respect to the others,
 * across all processes that share the store.
 */
export interface QuotaStore {
  /**
   * Reserves every charge or none of them. Reservations not committed or released
   * by `now + ttlMs` are released automatically.
   */
  reserve(charges: Charge[], options: { now: number; ttlMs: number }): Promise<ReserveResult>;
  /**
   * Replaces each token window's estimate with the matching real count (total for
   * tpm/tpd, input for itpm, output for otpm); unknown counts keep the estimate.
   * A reservation that already expired is recorded as fresh usage.
   */
  commit(reservation: Reservation, actualTokens: ActualTokens | undefined, now: number): Promise<void>;
  /** Gives the reserved capacity back (the call never reached the provider, or was rejected). */
  release(reservation: Reservation, now: number): Promise<void>;
  /** Raises our counters to what the provider reports. Never lowers them. */
  applyProviderTruth(key: string, limits: Limits, truths: ProviderTruth[], now: number): Promise<void>;
  usage(key: string, limits: Limits, now: number): Promise<Usage>;
  setCooldown(memberId: string, untilMs: number): Promise<void>;
  getCooldown(memberId: string, now: number): Promise<number>;
  setSticky(key: string, memberId: string, ttlMs: number, now: number): Promise<void>;
  getSticky(key: string, now: number): Promise<string | undefined>;
  /** Lowers an adaptive limit factor after a 429 (debounced across instances). */
  adapt(key: string, now: number, options: AdaptOptions): Promise<{ factor: number; changed: boolean }>;
  /** Current factors below 1 for these keys, recovered to `now`. */
  getAdapted(keys: string[], now: number, recoverMs: number): Promise<Record<string, number>>;
}

