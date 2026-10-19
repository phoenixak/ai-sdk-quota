import type { Dimension, Limits, ProviderTruth } from '../types.js';
import {
  DIMENSIONS,
  bucketStart,
  isTokenDimension,
  nextResetMs,
  retryAfterMs,
  windowSpec,
  windowStart,
  windowSum,
} from '../windows.js';
import type { Charge, Placement, QuotaStore, Reservation, ReserveResult, Usage } from './types.js';

interface Series {
  buckets: Map<number, number>;
  limits: Limits;
}

interface Floor {
  used: number;
  until: number;
}

/**
 * Keeps everything in this process. Correct for a single long-running server;
 * on serverless every instance has its own copy, so use a shared store there.
 */
export function memoryStore(): QuotaStore {
  const series = new Map<string, Series>();
  const floors = new Map<string, Floor>();
  const live = new Map<string, Reservation>();
  const cooldowns = new Map<string, number>();
  const sticky = new Map<string, { memberId: string; until: number }>();
  let nextId = 0;

  const seriesKey = (key: string, dim: Dimension) => `${key}|${dim}`;

  function getSeries(key: string, dim: Dimension, limits: Limits): Series {
    const id = seriesKey(key, dim);
    let s = series.get(id);
    if (!s) {
      s = { buckets: new Map(), limits };
      series.set(id, s);
    }
    s.limits = limits;
    return s;
  }

  function prune(s: Series, dim: Dimension, now: number) {
    const from = windowStart(windowSpec(dim, s.limits.dailyReset), now);
    for (const start of s.buckets.keys()) if (start < from) s.buckets.delete(start);
  }

  /** Adjusts a bucket of a live reservation; its series always exists. */
  function add(id: string, bucket: number, amount: number) {
    const s = series.get(id)!;
    const current = s.buckets.get(bucket);
    // A bucket that was pruned has left the window; adjusting it would count usage twice.
    if (current === undefined) return;
    s.buckets.set(bucket, Math.max(0, current + amount));
  }

  function undo(reservation: Reservation) {
    for (const p of reservation.placements) add(seriesKey(p.key, p.dim), p.bucket, -p.amount);
  }

  function sweep(now: number) {
    for (const [id, r] of live) {
      if (r.expiresAt <= now) {
        undo(r);
        live.delete(id);
      }
    }
  }

  function floorFor(key: string, dim: Dimension, now: number): number {
    const f = floors.get(seriesKey(key, dim));
    return f && f.until > now ? f.used : 0;
  }

  function amountFor(charge: Charge, dim: Dimension): number {
    return isTokenDimension(dim) ? charge.tokens : charge.requests;
  }

  return {
    async reserve(charges, { now, ttlMs }): Promise<ReserveResult> {
      sweep(now);
      let worst: { retryAfterMs: number; key: string; dim: Dimension } | undefined;
      for (const charge of charges) {
        for (const dim of DIMENSIONS) {
          const limit = charge.limits[dim];
          const need = amountFor(charge, dim);
          if (limit === undefined || need <= 0) continue;
          const spec = windowSpec(dim, charge.limits.dailyReset);
          const s = getSeries(charge.key, dim, charge.limits);
          prune(s, dim, now);
          const used = windowSum(s.buckets, spec, now);
          const floor = floorFor(charge.key, dim, now);
          // The provider reported more usage than we counted: wait for its reset.
          const wait =
            floor > used && floor + need > limit
              ? need > limit
                ? Infinity
                : floors.get(seriesKey(charge.key, dim))!.until - now
              : retryAfterMs(s.buckets, spec, now, need, limit);
          if (wait > 0 && (!worst || wait > worst.retryAfterMs)) worst = { retryAfterMs: wait, key: charge.key, dim };
        }
      }
      if (worst) return { ok: false, retryAfterMs: worst.retryAfterMs, blocked: { key: worst.key, dim: worst.dim } };

      const placements: Placement[] = [];
      for (const charge of charges) {
        for (const dim of DIMENSIONS) {
          const amount = amountFor(charge, dim);
          if (charge.limits[dim] === undefined || amount <= 0) continue;
          const s = getSeries(charge.key, dim, charge.limits);
          const bucket = bucketStart(windowSpec(dim, charge.limits.dailyReset), now);
          s.buckets.set(bucket, (s.buckets.get(bucket) ?? 0) + amount);
          placements.push({ key: charge.key, dim, bucket, amount });
        }
      }
      const reservation: Reservation = { id: `r${++nextId}`, placements, expiresAt: now + ttlMs };
      live.set(reservation.id, reservation);
      return { ok: true, reservation };
    },

    async commit(reservation, actualTokens, now) {
      sweep(now);
      if (live.delete(reservation.id)) {
        if (actualTokens === undefined) return;
        for (const p of reservation.placements) {
          if (isTokenDimension(p.dim)) add(seriesKey(p.key, p.dim), p.bucket, actualTokens - p.amount);
        }
        return;
      }
      // Expired before commit: the call still happened, so record it now.
      for (const p of reservation.placements) {
        const s = series.get(seriesKey(p.key, p.dim));
        if (!s) continue;
        const amount = isTokenDimension(p.dim) ? (actualTokens ?? p.amount) : p.amount;
        const bucket = bucketStart(windowSpec(p.dim, s.limits.dailyReset), now);
        s.buckets.set(bucket, (s.buckets.get(bucket) ?? 0) + amount);
      }
    },

    async release(reservation, now) {
      sweep(now);
      if (live.delete(reservation.id)) undo(reservation);
    },

    async applyProviderTruth(key, limits, truths: ProviderTruth[], now) {
      for (const t of truths) {
        const limit = limits[t.dim];
        if (limit === undefined) continue;
        const used = Math.max(0, limit - t.remaining);
        const id = seriesKey(key, t.dim);
        const current = floors.get(id);
        if (!current || current.until <= now || used >= current.used) floors.set(id, { used, until: now + t.resetInMs });
      }
    },

    async usage(key, limits, now) {
      sweep(now);
      const out: Usage = {};
      for (const dim of DIMENSIONS) {
        const limit = limits[dim];
        if (limit === undefined) continue;
        const spec = windowSpec(dim, limits.dailyReset);
        const s = getSeries(key, dim, limits);
        prune(s, dim, now);
        const counted = windowSum(s.buckets, spec, now);
        const floor = floorFor(key, dim, now);
        const used = Math.max(counted, floor);
        const resetInMs =
          floor > counted ? floors.get(seriesKey(key, dim))!.until - now : nextResetMs(s.buckets, spec, now);
        out[dim] = { used, limit, remaining: Math.max(0, limit - used), resetInMs };
      }
      return out;
    },

    async setCooldown(memberId, untilMs) {
      cooldowns.set(memberId, Math.max(untilMs, cooldowns.get(memberId) ?? 0));
    },

    async getCooldown(memberId, now) {
      const until = cooldowns.get(memberId) ?? 0;
      return until > now ? until : 0;
    },

    async setSticky(key, memberId, ttlMs, now) {
      sticky.set(key, { memberId, until: now + ttlMs });
    },

    async getSticky(key, now) {
      const s = sticky.get(key);
      return s && s.until > now ? s.memberId : undefined;
    },
  };
}
