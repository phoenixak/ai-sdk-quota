import type { DailyReset, Dimension } from './types.js';

export const DIMENSIONS: readonly Dimension[] = ['rps', 'rpm', 'rpd', 'tpm', 'tpd', 'itpm', 'otpm'];

export function isTokenDimension(dim: Dimension): boolean {
  return dim === 'tpm' || dim === 'tpd' || dim === 'itpm' || dim === 'otpm';
}

/** Which token count a window measures: all tokens, prompt tokens or completion tokens. */
export function tokenKind(dim: Dimension): 'total' | 'input' | 'output' {
  return dim === 'itpm' ? 'input' : dim === 'otpm' ? 'output' : 'total';
}

/**
 * Rolling windows are summed over fixed-size buckets. An event anywhere in a bucket
 * is treated as if it happened at the bucket's end, so a bucket keeps counting until
 * its latest possible event has left the window. The sum can only over-count: limits
 * are never exceeded, at the cost of freeing capacity up to one bucket late.
 */
export type WindowSpec =
  | { kind: 'rolling'; windowMs: number; bucketMs: number }
  | { kind: 'calendar'; timeZone: string };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
/**
 * Short windows count each call a little longer than the provider does, because the
 * provider stamps a request when it arrives and we stamp it when we send it. Without
 * this, a pool running a model right at its limit gets 429s from timing jitter alone
 * (measured against Groq, 2026-10-19).
 */
export const SLACK = { rps: 100, minute: SECOND } as const;

export function windowSpec(dim: Dimension, dailyReset: DailyReset = 'rolling'): WindowSpec {
  switch (dim) {
    case 'rps':
      return { kind: 'rolling', windowMs: SECOND + SLACK.rps, bucketMs: 100 };
    case 'rpm':
    case 'tpm':
    case 'itpm':
    case 'otpm':
      return { kind: 'rolling', windowMs: MINUTE + SLACK.minute, bucketMs: SECOND };
    case 'rpd':
    case 'tpd':
      return dailyReset === 'rolling'
        ? { kind: 'rolling', windowMs: DAY, bucketMs: 15 * MINUTE }
        : { kind: 'calendar', timeZone: dailyReset.timeZone };
  }
}

/** Start of the bucket that `now` falls into. */
export function bucketStart(spec: WindowSpec, now: number): number {
  return spec.kind === 'rolling' ? Math.floor(now / spec.bucketMs) * spec.bucketMs : dayStart(now, spec.timeZone);
}

/** Buckets starting at or after this time count toward the window. */
export function windowStart(spec: WindowSpec, now: number): number {
  return spec.kind === 'rolling' ? bucketStart(spec, now) - spec.windowMs : dayStart(now, spec.timeZone);
}

/** When a rolling bucket stops counting: its last possible event plus the window. */
function bucketExpiry(spec: { windowMs: number; bucketMs: number }, start: number): number {
  return start + spec.bucketMs + spec.windowMs;
}

export function windowSum(buckets: Iterable<[number, number]>, spec: WindowSpec, now: number): number {
  const from = windowStart(spec, now);
  let sum = 0;
  for (const [start, amount] of buckets) if (start >= from) sum += amount;
  return sum;
}

/**
 * How long until `need` more fits under `limit`, given the usage in `buckets`.
 * 0 if it fits now, `Infinity` if it can never fit.
 */
export function retryAfterMs(
  buckets: Iterable<[number, number]>,
  spec: WindowSpec,
  now: number,
  need: number,
  limit: number,
): number {
  if (need > limit) return Infinity;
  const from = windowStart(spec, now);
  const live = [...buckets].filter(([start]) => start >= from).sort((a, b) => a[0] - b[0]);
  const used = live.reduce((sum, [, amount]) => sum + amount, 0);
  const excess = used + need - limit;
  if (excess <= 0) return 0;
  if (spec.kind === 'calendar') return nextDayStart(now, spec.timeZone) - now;
  // need <= limit means excess <= used, so expiring the live buckets always frees enough.
  let freed = 0;
  let i = 0;
  while (freed < excess) freed += live[i++]![1];
  return bucketExpiry(spec, live[i - 1]![0]) - now;
}

/** When the window next frees capacity: the oldest bucket's expiry, or the next local midnight. */
export function nextResetMs(buckets: Iterable<[number, number]>, spec: WindowSpec, now: number): number {
  if (spec.kind === 'calendar') return nextDayStart(now, spec.timeZone) - now;
  const from = windowStart(spec, now);
  let oldest = Infinity;
  for (const [start, amount] of buckets) if (start >= from && amount > 0 && start < oldest) oldest = start;
  return oldest === Infinity ? 0 : bucketExpiry(spec, oldest) - now;
}

// Time zone math with Intl only, so there are no dependencies.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallTime(t: number, timeZone: string): WallTime {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(t)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out as unknown as WallTime;
}

/** The zone's UTC offset at instant `t`, in ms (wall clock minus UTC). */
function offsetAt(t: number, timeZone: string): number {
  const w = wallTime(t, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(t / SECOND) * SECOND;
}

/** The instant of local midnight at the start of the given calendar date in `timeZone`. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}

/** Start of the local calendar day containing `now`. */
export function dayStart(now: number, timeZone: string): number {
  const w = wallTime(now, timeZone);
  return localMidnight(w.year, w.month, w.day, timeZone);
}

/** Start of the local calendar day after the one containing `now`. */
export function nextDayStart(now: number, timeZone: string): number {
  const w = wallTime(now, timeZone);
  const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
}
