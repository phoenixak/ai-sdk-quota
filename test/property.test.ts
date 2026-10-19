import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../src/clock.js';
import { createQuotaPool } from '../src/pool.js';
import { memoryStore } from '../src/store/memory.js';
import type { Limits, PoolEvent } from '../src/types.js';
import { apiError, generated, mock, usage, userPrompt } from './helpers.js';

const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);
const T0 = Date.UTC(2026, 9, 19, 23, 50); // close to a UTC midnight, so daily groups reset mid-run

type Outcome = 'ok' | '429' | '503';

interface Call {
  memberId: string;
  at: number;
  tokens: number;
}

/** Calls in any trailing window ending at a call never exceed `limit`. */
function rollingOk(calls: Call[], windowMs: number, limit: number, amount: (c: Call) => number): boolean {
  return calls.every((end) => {
    const sum = calls.filter((c) => c.at > end.at - windowMs && c.at <= end.at).reduce((s, c) => s + amount(c), 0);
    return sum <= limit;
  });
}

function perUtcDayOk(calls: Call[], limit: number): boolean {
  const days = new Map<number, number>();
  for (const c of calls) {
    const day = Math.floor(c.at / 86_400_000);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return [...days.values()].every((n) => n <= limit);
}

const memberLimits = fc.record(
  {
    rpm: fc.integer({ min: 1, max: 6 }),
    rpd: fc.integer({ min: 1, max: 20 }),
    tpm: fc.integer({ min: 600, max: 3_000 }),
  },
  { requiredKeys: ['rpm'] },
);

const scenario = fc.record({
  limits: fc.array(memberLimits, { minLength: 1, maxLength: 4 }),
  groupRpd: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
  strategy: fc.constantFrom('priority' as const, 'most-headroom' as const, 'weighted' as const),
  // Bursts of concurrent calls, each followed by a clock step.
  bursts: fc.array(
    fc.record({
      size: fc.integer({ min: 1, max: 8 }),
      stepMs: fc.integer({ min: 0, max: 40_000 }),
      outcomes: fc.array(fc.constantFrom<Outcome>('ok', 'ok', 'ok', '429', '503'), { minLength: 8, maxLength: 8 }),
      usageFraction: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    { minLength: 1, maxLength: 12 },
  ),
  seed: fc.integer(),
});

describe('property: limits are never exceeded', () => {
  it(`holds for concurrent bursts on a fake clock (${RUNS} runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (sc) => {
        const clock = fakeClock(T0);
        const reached: Call[] = [];
        const lastEstimate = new Map<string, number>();
        let fraction = 1;
        let rnd = sc.seed;
        const random = () => {
          rnd = (rnd * 1_103_515_245 + 12_345) % 2_147_483_648;
          return Math.abs(rnd) / 2_147_483_648;
        };

        const models = sc.limits.map((limits, i) => {
          const id = `m${i}`;
          const model = mock('test.chat', id, {
            doGenerate: async (options) => {
              const outcome = options.headers?.['x-outcome'] as Outcome;
              if (outcome === '429') throw apiError(429);
              const estimated = lastEstimate.get(id)!;
              // Real usage never above the estimate here; see the token check below.
              const tokens = Math.floor(estimated * fraction);
              reached.push({ memberId: id, at: clock.now(), tokens: outcome === '503' ? estimated : tokens });
              if (outcome === '503') throw apiError(503);
              return generated('ok', usage(tokens, 0));
            },
          });
          return { id, model, limits: limits as Limits, ...(sc.groupRpd ? { groups: ['shared'] } : {}) };
        });

        const pool = createQuotaPool({
          models,
          store: memoryStore(),
          strategy: sc.strategy,
          clock,
          random,
          failureCooldownMs: 1_000,
          ...(sc.groupRpd ? { groups: { shared: { rpd: sc.groupRpd, dailyReset: { timeZone: 'UTC' } } } } : {}),
          onEvent: (e: PoolEvent) => {
            if (e.type === 'route') lastEstimate.set(e.memberId, e.estimatedTokens);
          },
        });

        for (const burst of sc.bursts) {
          fraction = burst.usageFraction;
          await Promise.all(
            Array.from({ length: burst.size }, (_, i) =>
              Promise.resolve(
                pool.model().doGenerate({ prompt: userPrompt('hello there'), headers: { 'x-outcome': burst.outcomes[i]! } }),
              ).catch(() => undefined),
            ),
          );
          clock.advance(burst.stepMs);
        }

        sc.limits.forEach((limits, i) => {
          const calls = reached.filter((c) => c.memberId === `m${i}`);
          expect(rollingOk(calls, 60_000, limits.rpm, () => 1)).toBe(true);
          if (limits.rpd !== undefined) expect(rollingOk(calls, 86_400_000, limits.rpd, () => 1)).toBe(true);
          if (limits.tpm !== undefined) expect(rollingOk(calls, 60_000, limits.tpm, (c) => c.tokens)).toBe(true);
        });
        if (sc.groupRpd) expect(perUtcDayOk(reached, sc.groupRpd)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  }, 600_000);

  it(`expired reservations always free their capacity (${RUNS} runs)`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        async (limit, ttlMs, extra) => {
          const store = memoryStore();
          const limits = { rpd: limit };
          for (let i = 0; i < limit; i++) {
            const r = await store.reserve([{ key: 'k', limits, requests: 1, tokens: 0 }], { now: T0, ttlMs });
            expect(r.ok).toBe(true);
          }
          const full = await store.reserve([{ key: 'k', limits, requests: 1, tokens: 0 }], { now: T0 + ttlMs - 1, ttlMs });
          expect(full.ok).toBe(false);
          // None was committed or released: after the TTL every slot is free again.
          for (let i = 0; i < limit; i++) {
            const r = await store.reserve([{ key: 'k', limits, requests: 1, tokens: 0 }], { now: T0 + ttlMs + extra, ttlMs: 1 });
            expect(r.ok).toBe(true);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
