import { describe, expect, it } from 'vitest';
import { type ResolvedMember, headroom, selectMembers } from '../src/select.js';
import { memoryStore } from '../src/store/memory.js';
import type { PoolMember } from '../src/types.js';
import { mock } from './helpers.js';

const T0 = 1_000_000;

function member(id: string, extra: Partial<PoolMember> = {}, limits = {}): ResolvedMember {
  return { member: { id, model: mock('p', id), ...extra }, key: `m:${id}`, limits, groups: [] };
}

const base = { now: T0, strategy: 'priority' as const, random: () => 0.5 };

describe('selectMembers', () => {
  it('filters by capability, tag and cooldown, keeping priority order', async () => {
    const store = memoryStore();
    await store.setCooldown('c', T0 + 5_000);
    const { ordered, skipped } = await selectMembers({
      ...base,
      store,
      members: [
        member('a', { capabilities: { tools: false } }),
        member('b', { tags: ['may-train'] }),
        member('c'),
        member('d', { capabilities: { tools: true } }),
        member('e'),
      ],
      require: ['tools'],
      exclude: ['may-train'],
    });
    expect(ordered.map((m) => m.member.id)).toEqual(['d', 'e']);
    expect(skipped).toEqual([
      { memberId: 'a', reason: 'capability' },
      { memberId: 'b', reason: 'excluded' },
      { memberId: 'c', reason: 'cooldown', retryAfterMs: 5_000 },
    ]);
  });

  it('orders by headroom, ties keep priority', async () => {
    const store = memoryStore();
    const a = member('a', {}, { rpm: 10 });
    const b = member('b', {}, { rpm: 10 });
    const c = member('c');
    await store.reserve([{ key: 'm:a', limits: a.limits, requests: 5, tokens: 0 }], { now: T0, ttlMs: 60_000 });
    const { ordered } = await selectMembers({ ...base, strategy: 'most-headroom', store, members: [a, b, c] });
    expect(ordered.map((m) => m.member.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders by weighted random', async () => {
    const store = memoryStore();
    const members = [member('a', { weight: 1 }), member('b', { weight: 100 }), member('c', { weight: 0 })];
    const { ordered } = await selectMembers({ ...base, strategy: 'weighted', store, members });
    expect(ordered.map((m) => m.member.id)).toEqual(['b', 'a', 'c']);
    const unweighted = await selectMembers({ ...base, strategy: 'weighted', store, members: [member('x'), member('y')] });
    expect(unweighted.ordered).toHaveLength(2);
  });

  it('moves the sticky member to the front', async () => {
    const store = memoryStore();
    const members = [member('a'), member('b'), member('c')];
    const ids = async (sticky?: string) =>
      (await selectMembers({ ...base, store, members, stickyMemberId: sticky })).ordered.map((m) => m.member.id);
    expect(await ids('c')).toEqual(['c', 'a', 'b']);
    expect(await ids('a')).toEqual(['a', 'b', 'c']);
    expect(await ids('gone')).toEqual(['a', 'b', 'c']);
  });
});

describe('headroom', () => {
  it('takes the smallest fraction across the member and its groups', async () => {
    const store = memoryStore();
    const m: ResolvedMember = {
      ...member('a', {}, { rpm: 10, tpm: 0 }),
      groups: [{ key: 'g:x', limits: { rpd: 4 } }],
    };
    expect(await headroom(m, store, T0)).toBe(1);
    await store.reserve([{ key: 'g:x', limits: { rpd: 4 }, requests: 3, tokens: 0 }], { now: T0, ttlMs: 60_000 });
    expect(await headroom(m, store, T0)).toBe(0.25);
  });
});
