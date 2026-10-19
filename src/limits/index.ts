import type { DailyReset, Limits } from '../types.js';
import data from './registry.json';

interface Sourced {
  source: string;
  verifiedAt: string;
  verified: boolean;
  note?: string;
}

export interface RegistryTier extends Sourced {
  dailyReset?: DailyReset;
  /** Per-model limits, keyed by the provider's model id. */
  models?: Record<string, Limits>;
  /** Limits for any model not listed in `models` (only those ending in `modelSuffix`, if set). */
  defaultModel?: Limits;
  modelSuffix?: string;
  /** Shared buckets every model in this tier also charges. */
  groups?: string[];
}

export interface RegistryGroup extends Sourced {
  limits: Limits;
}

export interface Registry {
  tiers: Record<string, RegistryTier>;
  groups: Record<string, RegistryGroup>;
}

/** Known free-tier limits, each with its source and the date it was checked. */
export const registry = data as Registry;

export interface ResolvedLimits {
  limits: Limits;
  groups: string[];
  verified: boolean;
}

/** Looks up a tier id such as `'groq:free'` for one model id. */
export function resolveLimits(tierId: string, modelId: string, from: Registry = registry): ResolvedLimits | undefined {
  const tier = from.tiers[tierId];
  if (!tier) return undefined;
  const listed = tier.models?.[modelId];
  const fallback = !tier.modelSuffix || modelId.endsWith(tier.modelSuffix) ? tier.defaultModel : undefined;
  const base = listed ?? fallback;
  if (!base) return undefined;
  const limits: Limits = tier.dailyReset ? { dailyReset: tier.dailyReset, ...base } : { ...base };
  return { limits, groups: tier.groups ?? [], verified: tier.verified };
}

export function resolveGroup(groupId: string, from: Registry = registry): Limits | undefined {
  return from.groups[groupId]?.limits;
}

/** Entries checked more than `maxAgeDays` ago; CI warns about these. */
export function staleEntries(now: number, maxAgeDays = 60, from: Registry = registry): string[] {
  const cutoff = now - maxAgeDays * 86_400_000;
  return [...Object.entries(from.tiers), ...Object.entries(from.groups)]
    .filter(([, entry]) => Date.parse(entry.verifiedAt) < cutoff)
    .map(([id]) => id);
}
