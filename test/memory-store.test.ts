import { describe, expect, it } from 'vitest';
import { fakeClock, systemClock } from '../src/clock.js';
import { memoryStore } from '../src/store/memory.js';
import { describeStoreContract } from './store-contract.js';

describeStoreContract('memoryStore', () => memoryStore());

describe('memoryStore internals', () => {
  it('does not adjust a bucket that already left the window', async () => {
    const store = memoryStore();
    const limits = { tpm: 1_000 };
    const r = await store.reserve([{ key: 'm', limits, requests: 1, tokens: 500 }], { now: 0, ttlMs: 600_000 });
    if (!r.ok) throw new Error('blocked');
    // Once the window (plus slack) has passed, usage() prunes the bucket; the late commit must not resurrect it.
    expect((await store.usage('m', limits, 62_000)).tpm?.used).toBe(0);
    await store.commit(r.reservation, 900, 62_000);
    expect((await store.usage('m', limits, 62_000)).tpm?.used).toBe(0);
  });

  it('ignores placements for unknown series', async () => {
    const store = memoryStore();
    await store.commit({ id: 'nope', placements: [{ key: 'x', dim: 'rpm', bucket: 0, amount: 1 }], expiresAt: 0 }, 1, 10);
    await store.release({ id: 'nope', placements: [], expiresAt: 0 }, 10);
    expect(await store.usage('x', { rpm: 5 }, 10)).toEqual({ rpm: { used: 0, limit: 5, remaining: 5, resetInMs: 0 } });
  });

  it('adds a late commit to a bucket that already has usage', async () => {
    const store = memoryStore();
    const limits = { rpm: 10 };
    const late = await store.reserve([{ key: 'm', limits, requests: 1, tokens: 0 }], { now: 0, ttlMs: 10 });
    await store.reserve([{ key: 'm', limits, requests: 1, tokens: 0 }], { now: 20, ttlMs: 1_000 });
    if (!late.ok) throw new Error('blocked');
    await store.commit(late.reservation, undefined, 30);
    expect((await store.usage('m', limits, 30)).rpm?.used).toBe(2);
  });

  it('records a late commit in the current bucket', async () => {
    const store = memoryStore();
    const limits = { tpm: 1_000 };
    const r = await store.reserve([{ key: 'm', limits, requests: 1, tokens: 300 }], { now: 0, ttlMs: 10 });
    if (!r.ok) throw new Error('blocked');
    await store.commit(r.reservation, 120, 5_000);
    expect((await store.usage('m', limits, 5_000)).tpm).toEqual({ used: 120, limit: 1_000, remaining: 880, resetInMs: 62_000 });
  });
});

describe('clocks', () => {
  it('fake clock moves only when told', () => {
    const c = fakeClock(10);
    c.advance(5);
    expect(c.now()).toBe(15);
    c.set(100);
    expect(c.now()).toBe(100);
    expect(fakeClock().now()).toBe(0);
  });

  it('system clock follows Date.now', () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(50);
  });
});
