import type { QuotaStore } from './store/types.js';
import type { Capabilities, Limits, PoolMember, SkipReason } from './types.js';
import { DIMENSIONS } from './windows.js';

export type Strategy = 'priority' | 'most-headroom' | 'weighted';

/** A pool member with its limits and groups resolved. */
export interface ResolvedMember {
  member: PoolMember;
  key: string;
  limits: Limits;
  groups: { key: string; limits: Limits }[];
}

export interface SelectInput {
  members: ResolvedMember[];
  store: QuotaStore;
  now: number;
  strategy: Strategy;
  random: () => number;
  require?: (keyof Capabilities)[] | undefined;
  exclude?: string[] | undefined;
  stickyMemberId?: string | undefined;
}

export interface Skip {
  memberId: string;
  reason: SkipReason;
  retryAfterMs?: number;
}

/** Filters members by capabilities, tags and cooldowns, then orders them by the strategy. */
export async function selectMembers(input: SelectInput): Promise<{ ordered: ResolvedMember[]; skipped: Skip[] }> {
  const skipped: Skip[] = [];
  const eligible: ResolvedMember[] = [];
  for (const m of input.members) {
    const caps = m.member.capabilities ?? {};
    if (input.require?.some((cap) => caps[cap] === false)) {
      skipped.push({ memberId: m.member.id, reason: 'capability' });
      continue;
    }
    if (input.exclude?.some((tag) => m.member.tags?.includes(tag))) {
      skipped.push({ memberId: m.member.id, reason: 'excluded' });
      continue;
    }
    const until = await input.store.getCooldown(m.member.id, input.now);
    if (until > 0) {
      skipped.push({ memberId: m.member.id, reason: 'cooldown', retryAfterMs: until - input.now });
      continue;
    }
    eligible.push(m);
  }

  let ordered = eligible;
  if (input.strategy === 'most-headroom') {
    const scored = await Promise.all(eligible.map(async (m) => ({ m, score: await headroom(m, input.store, input.now) })));
    // Array.prototype.sort is stable, so ties keep priority order.
    ordered = scored.sort((a, b) => b.score - a.score).map((s) => s.m);
  } else if (input.strategy === 'weighted') {
    // Weighted random order (Efraimidis–Spirakis): key = u^(1/w), highest first.
    ordered = eligible
      .map((m) => ({ m, key: input.random() ** (1 / Math.max(m.member.weight ?? 1, Number.EPSILON)) }))
      .sort((a, b) => b.key - a.key)
      .map((s) => s.m);
  }

  const sticky = ordered.findIndex((m) => m.member.id === input.stickyMemberId);
  if (sticky > 0) ordered = [ordered[sticky]!, ...ordered.slice(0, sticky), ...ordered.slice(sticky + 1)];
  return { ordered, skipped };
}

/** The smallest remaining fraction over every window of the member and its groups (1 when unlimited). */
export async function headroom(m: ResolvedMember, store: QuotaStore, now: number): Promise<number> {
  let min = 1;
  for (const { key, limits } of [{ key: m.key, limits: m.limits }, ...m.groups]) {
    const usage = await store.usage(key, limits, now);
    for (const dim of DIMENSIONS) {
      const u = usage[dim];
      if (u && u.limit > 0) min = Math.min(min, u.remaining / u.limit);
    }
  }
  return min;
}
