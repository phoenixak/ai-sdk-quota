import type { Dimension, Limits } from '../types.js';
import { DIMENSIONS, bucketStart, isTokenDimension, nextResetMs, windowSpec, windowStart } from '../windows.js';
import { type AdaptOptions, type Adapted, recovered } from './adaptive.js';
import { floorAt } from './floor.js';
import type { Placement, QuotaStore, Reservation, Usage } from './types.js';

/**
 * One window check, fully precomputed on the client: the backend never does time
 * zone math, it only sums, compares and places, atomically.
 */
export interface SeriesOp {
  series: string;
  need: number;
  limit: number;
  /** Buckets starting before this are out of the window. */
  from: number;
  /** The bucket a new charge goes into. */
  bucket: number;
  /** 0 = rolling, 1 = calendar day. */
  kind: 0 | 1;
  windowMs: number;
  bucketMs: number;
  /** Calendar windows: ms until the next local midnight. */
  nextResetMs: number;
  /** How long the series must be kept before it can be deleted. */
  keepMs: number;
}

export interface CommitPlacement {
  series: string;
  bucket: number;
  amount: number;
  isToken: boolean;
  /** Where a commit for an already-expired reservation records its usage. */
  nowBucket: number;
  keepMs: number;
}

export interface SeriesUsage {
  floorUsed: number;
  floorUntil: number;
  /** When the provider reading was taken. */
  floorAt: number;
  floorDrain: boolean;
  /** Calls reserved since the reading. */
  floorAdded: number;
  /** Buckets at or after `from`. */
  buckets: [number, number][];
}

/** The atomic primitives a shared store must provide; `createScriptedStore` does the rest. */
export interface StoreBackend {
  /** `wait` is -1 when the charge can never fit. `index` is 1-based into `ops`. */
  reserve(args: { ops: SeriesOp[]; id: string; now: number; ttlMs: number }): Promise<
    { ok: true } | { ok: false; wait: number; index: number }
  >;
  commit(args: { id: string; actual: number | undefined; placements: CommitPlacement[]; now: number }): Promise<void>;
  release(args: { id: string; now: number }): Promise<void>;
  truth(args: { entries: { series: string; used: number; until: number; drain: boolean }[]; now: number }): Promise<void>;
  usage(args: { entries: { series: string; from: number }[]; now: number }): Promise<SeriesUsage[]>;
  setCooldown(memberId: string, until: number, ttlMs: number): Promise<void>;
  getCooldown(memberId: string): Promise<number | undefined>;
  setSticky(key: string, memberId: string, until: number, ttlMs: number): Promise<void>;
  getSticky(key: string): Promise<{ memberId: string; until: number } | undefined>;
  /** Applies `lowered()` from adaptive.ts atomically. */
  adapt(key: string, now: number, options: AdaptOptions): Promise<{ factor: number; changed: boolean }>;
  /** Raw records (not recovered) for these keys. */
  getAdapted(keys: string[]): Promise<(Adapted | undefined)[]>;
}

const seriesName = (key: string, dim: Dimension) => `${key}|${dim}`;

function keepFor(spec: ReturnType<typeof windowSpec>, nextReset: number): number {
  return spec.kind === 'rolling' ? spec.windowMs + 2 * spec.bucketMs : nextReset + 60_000;
}

function op(key: string, dim: Dimension, limits: Limits, need: number, limit: number, now: number): SeriesOp {
  const spec = windowSpec(dim, limits.dailyReset);
  const nextReset = spec.kind === 'calendar' ? nextResetMs([], spec, now) : 0;
  return {
    series: seriesName(key, dim),
    need,
    limit,
    from: windowStart(spec, now),
    bucket: bucketStart(spec, now),
    kind: spec.kind === 'rolling' ? 0 : 1,
    windowMs: spec.kind === 'rolling' ? spec.windowMs : 0,
    bucketMs: spec.kind === 'rolling' ? spec.bucketMs : 0,
    nextResetMs: nextReset,
    keepMs: keepFor(spec, nextReset),
  };
}

/** A QuotaStore on top of a backend that runs the atomic parts (Redis Lua, Postgres function). */
export function createScriptedStore(backend: StoreBackend): QuotaStore {
  return {
    async reserve(charges, { now, ttlMs }) {
      const ops: SeriesOp[] = [];
      const meta: { key: string; dim: Dimension; limits: Limits }[] = [];
      for (const charge of charges) {
        for (const dim of DIMENSIONS) {
          const limit = charge.limits[dim];
          const need = isTokenDimension(dim) ? charge.tokens : charge.requests;
          if (limit === undefined || need <= 0) continue;
          ops.push(op(charge.key, dim, charge.limits, need, limit, now));
          meta.push({ key: charge.key, dim, limits: charge.limits });
        }
      }
      const id = crypto.randomUUID();
      const result = await backend.reserve({ ops, id, now, ttlMs });
      if (!result.ok) {
        const blocked = meta[result.index - 1]!;
        return {
          ok: false,
          retryAfterMs: result.wait === -1 ? Infinity : result.wait,
          blocked: { key: blocked.key, dim: blocked.dim },
        };
      }
      const placements: Placement[] = ops.map((o, i) => {
        const { key, dim, limits } = meta[i]!;
        return {
          key,
          dim,
          bucket: o.bucket,
          amount: o.need,
          ...(limits.dailyReset === undefined ? {} : { dailyReset: limits.dailyReset }),
        };
      });
      const reservation: Reservation = { id, placements, expiresAt: now + ttlMs };
      return { ok: true, reservation };
    },

    async commit(reservation, actualTokens, now) {
      const placements = reservation.placements.map((p): CommitPlacement => {
        const spec = windowSpec(p.dim, p.dailyReset);
        const nextReset = spec.kind === 'calendar' ? nextResetMs([], spec, now) : 0;
        return {
          series: seriesName(p.key, p.dim),
          bucket: p.bucket,
          amount: p.amount,
          isToken: isTokenDimension(p.dim),
          nowBucket: bucketStart(spec, now),
          keepMs: keepFor(spec, nextReset),
        };
      });
      await backend.commit({ id: reservation.id, actual: actualTokens, placements, now });
    },

    async release(reservation, now) {
      await backend.release({ id: reservation.id, now });
    },

    async applyProviderTruth(key, limits, truths, now) {
      const entries = truths.flatMap((t) => {
        const limit = limits[t.dim];
        return limit === undefined
          ? []
          : [
              {
                series: seriesName(key, t.dim),
                used: Math.max(0, (t.limit ?? limit) - t.remaining),
                until: now + t.resetInMs,
                drain: t.drain === true,
              },
            ];
      });
      if (entries.length) await backend.truth({ entries, now });
    },

    async usage(key, limits, now) {
      const dims = DIMENSIONS.filter((dim) => limits[dim] !== undefined);
      const specs = dims.map((dim) => windowSpec(dim, limits.dailyReset));
      const results = await backend.usage({
        entries: dims.map((dim, i) => ({ series: seriesName(key, dim), from: windowStart(specs[i]!, now) })),
        now,
      });
      const out: Usage = {};
      dims.forEach((dim, i) => {
        const limit = limits[dim]!;
        const r = results[i]!;
        const counted = r.buckets.reduce((sum, [, amount]) => sum + amount, 0);
        const floor = floorAt(
          { used: r.floorUsed, until: r.floorUntil, at: r.floorAt, drain: r.floorDrain, added: r.floorAdded },
          now,
        );
        const used = Math.max(counted, Math.ceil(floor));
        const resetInMs = floor > counted ? r.floorUntil - now : nextResetMs(r.buckets, specs[i]!, now);
        out[dim] = { used, limit, remaining: Math.max(0, limit - used), resetInMs };
      });
      return out;
    },

    async setCooldown(memberId, untilMs) {
      // The TTL only cleans up; expiry is decided by comparing with `now` on read.
      await backend.setCooldown(memberId, untilMs, Math.max(1_000, untilMs - Date.now() + 60_000));
    },

    async getCooldown(memberId, now) {
      const until = await backend.getCooldown(memberId);
      return until !== undefined && until > now ? until : 0;
    },

    async setSticky(key, memberId, ttlMs, now) {
      await backend.setSticky(key, memberId, now + ttlMs, Math.max(1_000, ttlMs));
    },

    async getSticky(key, now) {
      const s = await backend.getSticky(key);
      return s && s.until > now ? s.memberId : undefined;
    },

    adapt: (key, now, options) => backend.adapt(key, now, options),

    async getAdapted(keys, now, recoverMs) {
      const records = keys.length ? await backend.getAdapted(keys) : [];
      const out: Record<string, number> = {};
      keys.forEach((key, i) => {
        const factor = recovered(records[i], now, recoverMs);
        if (factor < 1) out[key] = factor;
      });
      return out;
    },
  };
}
