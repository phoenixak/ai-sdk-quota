import { describe, expect, it } from 'vitest';
import {
  bucketStart,
  dayStart,
  isTokenDimension,
  nextDayStart,
  nextResetMs,
  retryAfterMs,
  windowSpec,
  windowStart,
  windowSum,
} from '../src/windows.js';

const LA = 'America/Los_Angeles';
const H = 3_600_000;

describe('windowSpec', () => {
  it('maps dimensions to windows', () => {
    expect(windowSpec('rps')).toEqual({ kind: 'rolling', windowMs: 1_000, bucketMs: 100 });
    expect(windowSpec('rpm')).toEqual({ kind: 'rolling', windowMs: 60_000, bucketMs: 1_000 });
    expect(windowSpec('tpm')).toEqual({ kind: 'rolling', windowMs: 60_000, bucketMs: 1_000 });
    expect(windowSpec('rpd')).toEqual({ kind: 'rolling', windowMs: 24 * H, bucketMs: 15 * 60_000 });
    expect(windowSpec('tpd', { timeZone: 'UTC' })).toEqual({ kind: 'calendar', timeZone: 'UTC' });
  });

  it('knows token dimensions', () => {
    expect(isTokenDimension('tpm')).toBe(true);
    expect(isTokenDimension('tpd')).toBe(true);
    expect(isTokenDimension('rpm')).toBe(false);
  });
});

describe('rolling windows', () => {
  const spec = windowSpec('rpm');

  it('buckets by second and counts every bucket that may still hold a call from the last 60s', () => {
    expect(bucketStart(spec, 61_500)).toBe(61_000);
    expect(windowStart(spec, 61_500)).toBe(1_000);
    const buckets: [number, number][] = [
      [1_000, 5],
      [2_000, 3],
      [61_000, 1],
    ];
    // A call at 1.999s is still inside (1.5s, 61.5s], so the 1s bucket counts.
    expect(windowSum(buckets, spec, 61_500)).toBe(9);
    expect(windowSum(buckets, spec, 62_000)).toBe(4);
  });

  it('computes retry-after from the oldest buckets', () => {
    const buckets: [number, number][] = [
      [10_000, 2],
      [20_000, 3],
    ];
    expect(retryAfterMs(buckets, spec, 30_000, 1, 10)).toBe(0);
    // limit 5, used 5: need 1 frees when the 10s bucket's last possible call (10.999s) ages out at 71s.
    expect(retryAfterMs(buckets, spec, 30_000, 1, 5)).toBe(41_000);
    // need 4 needs both buckets gone: the 20s bucket stops counting at 81s.
    expect(retryAfterMs(buckets, spec, 30_000, 4, 5)).toBe(51_000);
    expect(retryAfterMs(buckets, spec, 30_000, 6, 5)).toBe(Infinity);
  });

  it('reports when the window next frees capacity', () => {
    expect(nextResetMs([], spec, 5_000)).toBe(0);
    expect(
      nextResetMs(
        [
          [20_000, 0],
          [30_000, 2],
          [10_000, 1],
        ],
        spec,
        35_000,
      ),
    ).toBe(36_000);
  });
});

describe('calendar windows', () => {
  it('resets at UTC midnight', () => {
    const now = Date.UTC(2026, 9, 19, 15, 30);
    expect(dayStart(now, 'UTC')).toBe(Date.UTC(2026, 9, 19));
    expect(nextDayStart(now, 'UTC')).toBe(Date.UTC(2026, 9, 20));
    const spec = windowSpec('rpd', { timeZone: 'UTC' });
    expect(bucketStart(spec, now)).toBe(Date.UTC(2026, 9, 19));
    expect(windowStart(spec, now)).toBe(Date.UTC(2026, 9, 19));
    expect(nextResetMs([], spec, now)).toBe(8.5 * H);
    const buckets: [number, number][] = [
      [Date.UTC(2026, 9, 18), 99],
      [Date.UTC(2026, 9, 19), 10],
    ];
    expect(windowSum(buckets, spec, now)).toBe(10);
    expect(retryAfterMs(buckets, spec, now, 1, 10)).toBe(8.5 * H);
  });

  it('resets at Pacific midnight on an ordinary day', () => {
    // 2026-10-19 12:00 PDT = 19:00Z; midnight PDT = 07:00Z.
    const now = Date.UTC(2026, 9, 19, 19);
    expect(dayStart(now, LA)).toBe(Date.UTC(2026, 9, 19, 7));
    expect(nextDayStart(now, LA)).toBe(Date.UTC(2026, 9, 20, 7));
  });

  it('handles the March change: a 23-hour day (2026-03-08)', () => {
    const noon = Date.UTC(2026, 2, 8, 20); // 13:00 PDT
    const start = dayStart(noon, LA);
    const next = nextDayStart(noon, LA);
    expect(start).toBe(Date.UTC(2026, 2, 8, 8)); // midnight PST
    expect(next).toBe(Date.UTC(2026, 2, 9, 7)); // midnight PDT
    expect(next - start).toBe(23 * H);
    // Just before and after the 02:00 jump stay in the same day.
    expect(dayStart(Date.UTC(2026, 2, 8, 9, 59), LA)).toBe(start);
    expect(dayStart(Date.UTC(2026, 2, 8, 10, 1), LA)).toBe(start);
    // One ms before the next midnight is still today; the midnight itself is tomorrow.
    expect(dayStart(next - 1, LA)).toBe(start);
    expect(dayStart(next, LA)).toBe(next);
  });

  it('handles the November change: a 25-hour day (2026-11-01)', () => {
    const noon = Date.UTC(2026, 10, 1, 20); // 12:00 PST
    const start = dayStart(noon, LA);
    const next = nextDayStart(noon, LA);
    expect(start).toBe(Date.UTC(2026, 10, 1, 7)); // midnight PDT
    expect(next).toBe(Date.UTC(2026, 10, 2, 8)); // midnight PST
    expect(next - start).toBe(25 * H);
    // Both 01:30s (PDT, then PST) are the same day.
    expect(dayStart(Date.UTC(2026, 10, 1, 8, 30), LA)).toBe(start);
    expect(dayStart(Date.UTC(2026, 10, 1, 9, 30), LA)).toBe(start);
    expect(dayStart(next - 1, LA)).toBe(start);
    expect(nextDayStart(next - 1, LA)).toBe(next);
  });

  it('crosses month and year ends', () => {
    const nye = Date.UTC(2027, 0, 1, 5); // 2026-12-31 21:00 PST
    expect(nextDayStart(nye, LA)).toBe(Date.UTC(2027, 0, 1, 8));
  });
});
