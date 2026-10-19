import { describe, expect, it } from 'vitest';
import { registry, resolveGroup, resolveLimits, staleEntries } from '../src/limits/index.js';

describe('limits registry', () => {
  it('resolves listed models', () => {
    expect(resolveLimits('groq:free', 'openai/gpt-oss-120b')).toEqual({
      limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
      groups: [],
      verified: true,
    });
    expect(resolveLimits('groq:free', 'llama-3.3-70b-versatile')).toBeUndefined();
    expect(resolveLimits('nope:free', 'x')).toBeUndefined();
  });

  it('resolves OpenRouter free models with the shared daily group', () => {
    expect(resolveLimits('openrouter:free', 'qwen/qwen3.8-27b:free')).toEqual({
      limits: { rpm: 20 },
      groups: ['openrouter:free-daily'],
      verified: true,
    });
    expect(resolveLimits('openrouter:free', 'qwen/qwen3.8-27b')).toBeUndefined();
    expect(resolveGroup('openrouter:free-daily')).toEqual({ rpd: 50, dailyReset: { timeZone: 'UTC' } });
    expect(resolveGroup('nope')).toBeUndefined();
  });

  it('marks unverified tiers and carries their daily reset', () => {
    expect(resolveLimits('gemini:free', 'gemini-3.5-flash-lite')).toEqual({
      limits: { dailyReset: { timeZone: 'America/Los_Angeles' }, rpm: 15, rpd: 120, tpm: 250000 },
      groups: [],
      verified: false,
    });
  });

  it('has a source and date on every entry, and none is stale on the verification day', () => {
    for (const entry of [...Object.values(registry.tiers), ...Object.values(registry.groups)]) {
      expect(entry.source).toMatch(/^https:\/\//);
      expect(Number.isNaN(Date.parse(entry.verifiedAt))).toBe(false);
    }
    expect(staleEntries(Date.UTC(2026, 9, 19))).toEqual([]);
    expect(staleEntries(Date.UTC(2027, 0, 1))).toContain('groq:free');
  });
});
