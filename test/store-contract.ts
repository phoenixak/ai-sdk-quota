import { describe, expect, it } from 'vitest';
import type { QuotaStore, Reservation } from '../src/store/types.js';
import type { Limits } from '../src/types.js';

/**
 * Behaviour every QuotaStore must have. Phase 2 stores (Upstash, ioredis, Postgres)
 * run this same suite.
 */
export function describeStoreContract(
  name: string,
  make: (prefix: string) => QuotaStore | Promise<QuotaStore>,
  options: { shared?: boolean } = {},
) {
  const T0 = Date.UTC(2026, 9, 19, 12);
  // A fresh namespace per test, so tests never see each other's keys.
  const makeStore = () => make(`t${Math.random().toString(36).slice(2, 10)}`);
  const TTL = 300_000;
  const charge = (key: string, limits: Limits, tokens = 0, requests = 1) => ({ key, limits, requests, tokens });

  async function reserveOk(store: QuotaStore, charges: Parameters<QuotaStore['reserve']>[0], now = T0) {
    const r = await store.reserve(charges, { now, ttlMs: TTL });
    if (!r.ok) throw new Error(`expected ok, blocked on ${r.blocked.key}/${r.blocked.dim}`);
    return r.reservation;
  }

  describe(`${name}: store contract`, () => {
    it('allows calls up to the limit and then blocks with a retry-after', async () => {
      const store = await makeStore();
      const limits = { rpm: 2 };
      await reserveOk(store, [charge('m:a', limits)]);
      await reserveOk(store, [charge('m:a', limits)], T0 + 500);
      const r = await store.reserve([charge('m:a', limits)], { now: T0 + 1_000, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.blocked).toEqual({ key: 'm:a', dim: 'rpm' });
        // Each bucket counts as if its calls came at its end, plus 1s timing slack:
        // capacity frees up to 2s late, never early.
        expect(r.retryAfterMs).toBe(61_000);
      }
      expect((await store.reserve([charge('m:a', limits)], { now: T0 + 61_999, ttlMs: TTL })).ok).toBe(false);
      await reserveOk(store, [charge('m:a', limits)], T0 + 62_000);
    });

    it('never lets a call expire early across a bucket edge (found by the property test)', async () => {
      const store = await makeStore();
      const limits = { rpm: 1 };
      await reserveOk(store, [charge('m:a', limits)], T0 + 17_642);
      // 59.358s later the first call is still inside the provider's 60s window.
      expect((await store.reserve([charge('m:a', limits)], { now: T0 + 78_999, ttlMs: TTL })).ok).toBe(false);
      await reserveOk(store, [charge('m:a', limits)], T0 + 79_000);
    });

    it('is all-or-nothing across keys', async () => {
      const store = await makeStore();
      const member = { rpm: 10 };
      const group = { rpd: 1 };
      await reserveOk(store, [charge('m:a', member), charge('g:shared', group)]);
      const r = await store.reserve([charge('m:b', member), charge('g:shared', group)], { now: T0, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.blocked).toEqual({ key: 'g:shared', dim: 'rpd' });
      // m:b was not charged by the failed attempt.
      expect((await store.usage('m:b', member, T0)).rpm?.used).toBe(0);
    });

    it('reports the longest wait when several windows are full', async () => {
      const store = await makeStore();
      const limits = { rpm: 1, rpd: 1 };
      await reserveOk(store, [charge('m:a', limits)]);
      const r = await store.reserve([charge('m:a', limits)], { now: T0, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.blocked.dim).toBe('rpd');
    });

    it('never admits a charge larger than the limit', async () => {
      const store = await makeStore();
      const r = await store.reserve([charge('m:a', { tpm: 100 }, 101)], { now: T0, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterMs).toBe(Infinity);
    });

    it('ignores dimensions without a limit and zero amounts', async () => {
      const store = await makeStore();
      const r = await reserveOk(store, [charge('m:a', { rpm: 1 }, 50), charge('m:b', { tpm: 10 }, 0)]);
      expect(r.placements).toEqual([{ key: 'm:a', dim: 'rpm', bucket: expect.any(Number), amount: 1 }]);
    });

    it('commit replaces the token estimate with real usage', async () => {
      const store = await makeStore();
      const limits = { tpm: 1_000, tpd: 10_000 };
      const r = await reserveOk(store, [charge('m:a', limits, 600)]);
      expect((await store.usage('m:a', limits, T0)).tpm?.used).toBe(600);
      await store.commit(r, 150, T0 + 10);
      const u = await store.usage('m:a', limits, T0 + 10);
      expect(u.tpm?.used).toBe(150);
      expect(u.tpd?.used).toBe(150);
    });

    it('commit without usage keeps the estimate', async () => {
      const store = await makeStore();
      const limits = { tpm: 1_000 };
      const r = await reserveOk(store, [charge('m:a', limits, 600)]);
      await store.commit(r, undefined, T0 + 10);
      expect((await store.usage('m:a', limits, T0 + 10)).tpm?.used).toBe(600);
    });

    it('release gives the capacity back, once', async () => {
      const store = await makeStore();
      const limits = { rpm: 1, tpm: 100 };
      const r = await reserveOk(store, [charge('m:a', limits, 80)]);
      await store.release(r, T0);
      await store.release(r, T0);
      const u = await store.usage('m:a', limits, T0);
      expect(u.rpm?.used).toBe(0);
      expect(u.tpm?.used).toBe(0);
    });

    it('releases reservations automatically when they expire', async () => {
      const store = await makeStore();
      const limits = { rpd: 1 };
      await store.reserve([charge('m:a', limits)], { now: T0, ttlMs: 1_000 });
      expect((await store.reserve([charge('m:a', limits)], { now: T0 + 999, ttlMs: 1_000 })).ok).toBe(false);
      expect((await store.reserve([charge('m:a', limits)], { now: T0 + 1_000, ttlMs: 1_000 })).ok).toBe(true);
    });

    it('records a commit that arrives after expiry as fresh usage', async () => {
      const store = await makeStore();
      const limits = { rpd: 5, tpd: 1_000 };
      const r = (await store.reserve([charge('m:a', limits, 100)], { now: T0, ttlMs: 1_000 })) as {
        ok: true;
        reservation: Reservation;
      };
      expect((await store.usage('m:a', limits, T0 + 2_000)).rpd?.used).toBe(0);
      await store.commit(r.reservation, 40, T0 + 2_000);
      const u = await store.usage('m:a', limits, T0 + 2_000);
      expect(u.rpd?.used).toBe(1);
      expect(u.tpd?.used).toBe(40);
      // Without real usage the estimate is recorded.
      const r2 = (await store.reserve([charge('m:b', limits, 100)], { now: T0, ttlMs: 1_000 })) as {
        ok: true;
        reservation: Reservation;
      };
      await store.commit(r2.reservation, undefined, T0 + 2_000);
      expect((await store.usage('m:b', limits, T0 + 2_000)).tpd?.used).toBe(100);
    });

    it('provider truth raises counters until its reset, and never lowers them', async () => {
      const store = await makeStore();
      const limits = { rpd: 1_000, tpm: 8_000 };
      await reserveOk(store, [charge('m:a', limits, 100)]);
      await store.applyProviderTruth(
        'm:a',
        limits,
        [
          { dim: 'rpd', remaining: 0, resetInMs: 3_000 },
          { dim: 'tpm', remaining: 7_990, resetInMs: 5_000 },
          { dim: 'rpm', remaining: 0, resetInMs: 5_000 },
        ],
        T0,
      );
      const u = await store.usage('m:a', limits, T0);
      expect(u.rpd).toEqual({ used: 1_000, limit: 1_000, remaining: 0, resetInMs: 3_000 });
      expect(u.tpm?.used).toBe(100);
      expect(u.rpm).toBeUndefined();
      const r = await store.reserve([charge('m:a', limits)], { now: T0 + 1_000, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterMs).toBe(2_000);
      // A lower reading inside the same window doesn't lower the floor.
      await store.applyProviderTruth('m:a', limits, [{ dim: 'rpd', remaining: 500, resetInMs: 3_000 }], T0 + 1_000);
      expect((await store.usage('m:a', limits, T0 + 1_000)).rpd?.used).toBe(1_000);
      // After the reset the floor no longer applies.
      expect((await store.reserve([charge('m:a', limits)], { now: T0 + 3_000, ttlMs: TTL })).ok).toBe(true);
      // A new reading after the old one expired replaces it.
      await store.applyProviderTruth('m:a', limits, [{ dim: 'rpd', remaining: 990, resetInMs: 3_000 }], T0 + 4_000);
      expect((await store.usage('m:a', limits, T0 + 4_000)).rpd?.used).toBe(10);
      // Readings for windows without a limit change nothing.
      await store.applyProviderTruth('m:a', { rpm: 5 }, [{ dim: 'tpd', remaining: 0, resetInMs: 1_000 }], T0 + 4_000);
      expect((await store.usage('m:a', { rpm: 5 }, T0 + 4_000)).rpm?.used).toBe(0);
    });

    it('a named 429 drains: after the first slot frees, exactly one call fits, not a burst', async () => {
      const store = await makeStore();
      const limits = { rpm: 30 };
      await store.applyProviderTruth('m:a', limits, [{ dim: 'rpm', remaining: 0, resetInMs: 61_000, drain: true }], T0);
      const first = await store.reserve([charge('m:a', limits)], { now: T0, ttlMs: TTL });
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.retryAfterMs).toBe(2_034);
      await reserveOk(store, [charge('m:a', limits)], T0 + 2_034);
      // The call just reserved counts on top of the drained reading.
      const second = await store.reserve([charge('m:a', limits)], { now: T0 + 2_034, ttlMs: TTL });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.retryAfterMs).toBe(2_033);
      expect((await store.usage('m:a', limits, T0 + 2_034)).rpm?.used).toBe(30);
      // Halfway through the window about half the slots are back.
      const results = [];
      for (let i = 0; i < 20; i++) results.push(await store.reserve([charge('m:a', limits)], { now: T0 + 30_500, ttlMs: TTL }));
      expect(results.filter((r) => r.ok)).toHaveLength(14);
    });

    it('measures a reading against the provider limit it reports', async () => {
      const store = await makeStore();
      // The pool enforces 900 of the provider's 1,000 (safetyMargin 0.9).
      const limits = { rpd: 900 };
      await store.applyProviderTruth('m:a', limits, [{ dim: 'rpd', remaining: 970, limit: 1_000, resetInMs: 60_000 }], T0);
      expect((await store.usage('m:a', limits, T0)).rpd?.used).toBe(30);
    });

    it('a real header reading replaces a draining estimate', async () => {
      const store = await makeStore();
      const limits = { tpm: 8_000 };
      await store.applyProviderTruth('m:a', limits, [{ dim: 'tpm', remaining: 0, resetInMs: 61_000, drain: true }], T0);
      await store.applyProviderTruth('m:a', limits, [{ dim: 'tpm', remaining: 7_000, resetInMs: 5_000 }], T0 + 1_000);
      expect((await store.usage('m:a', limits, T0 + 1_000)).tpm?.used).toBe(1_000);
      // And a draining estimate doesn't replace a real reading it doesn't exceed.
      await store.applyProviderTruth('m:a', limits, [{ dim: 'tpm', remaining: 7_500, resetInMs: 61_000, drain: true }], T0 + 2_000);
      expect((await store.usage('m:a', limits, T0 + 2_000)).tpm?.used).toBe(1_000);
    });

    it('a charge that can never fit is refused even under a provider floor', async () => {
      const store = await makeStore();
      const limits = { tpm: 100 };
      await store.applyProviderTruth('m:a', limits, [{ dim: 'tpm', remaining: 0, resetInMs: 5_000 }], T0);
      const r = await store.reserve([charge('m:a', limits, 500)], { now: T0, ttlMs: TTL });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryAfterMs).toBe(Infinity);
    });

    it('usage reports remaining capacity and the next reset', async () => {
      const store = await makeStore();
      const limits = { rpm: 3, rpd: 10, dailyReset: { timeZone: 'UTC' } } as const;
      await reserveOk(store, [charge('m:a', limits)]);
      const u = await store.usage('m:a', limits, T0 + 30_000);
      expect(u.rpm).toEqual({ used: 1, limit: 3, remaining: 2, resetInMs: 32_000 });
      expect(u.rpd).toEqual({ used: 1, limit: 10, remaining: 9, resetInMs: 12 * 3_600_000 - 30_000 });
    });

    it('stores cooldowns and keeps the later one', async () => {
      const store = await makeStore();
      expect(await store.getCooldown('a', T0)).toBe(0);
      await store.setCooldown('a', T0 + 5_000);
      await store.setCooldown('a', T0 + 1_000);
      expect(await store.getCooldown('a', T0)).toBe(T0 + 5_000);
      expect(await store.getCooldown('a', T0 + 5_000)).toBe(0);
    });

    it('admits exactly the limit under concurrent reserves', async () => {
      const store = await makeStore();
      const limits = { rpm: 7, tpm: 7_000 };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.reserve([charge('m:a', limits, 900)], { now: T0, ttlMs: TTL })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(7);
    });

    if (options.shared) {
      it('stays atomic across separate store instances (separate connections)', async () => {
        const prefix = `t${Math.random().toString(36).slice(2, 10)}`;
        const stores = await Promise.all(Array.from({ length: 4 }, () => make(prefix)));
        const limits = { rpd: 9 };
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) => stores[i % 4]!.reserve([charge('g:shared', limits)], { now: T0, ttlMs: TTL })),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(9);
        expect((await stores[0]!.usage('g:shared', limits, T0)).rpd?.used).toBe(9);
      });
    }

    it('keeps calendar-day placements usable for late commits', async () => {
      const store = await makeStore();
      const limits = { rpd: 5, tpd: 1_000, dailyReset: { timeZone: 'America/Los_Angeles' } } as const;
      const r = (await store.reserve([charge('m:a', limits, 100)], { now: T0, ttlMs: 1_000 })) as {
        ok: true;
        reservation: Reservation;
      };
      await store.commit(r.reservation, 30, T0 + 5_000);
      const u = await store.usage('m:a', limits, T0 + 5_000);
      expect(u.rpd?.used).toBe(1);
      expect(u.tpd?.used).toBe(30);
    });

    it('stores sticky members with a TTL', async () => {
      const store = await makeStore();
      expect(await store.getSticky('conv', T0)).toBeUndefined();
      await store.setSticky('conv', 'a', 1_000, T0);
      expect(await store.getSticky('conv', T0 + 999)).toBe('a');
      expect(await store.getSticky('conv', T0 + 1_000)).toBeUndefined();
    });
  });
}
