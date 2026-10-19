/**
 * A provider-reported lower bound on a window's usage, for usage we couldn't count
 * ourselves (other processes, earlier runs, clock skew). Effective usage is
 * `max(our own count, floor)`, where the floor is:
 *
 *   value(now) + added
 *
 * - `value` is what the provider reported at `at`. Flat readings (rate-limit headers:
 *   "N remaining, resets in T") hold until `until`. Draining readings (a 429 that named
 *   the window) fall linearly from `used` at `at` to 0 at `until`, assuming the
 *   provider's calls leave the window evenly: two seconds after an RPM 429 this admits
 *   one call, not a burst.
 * - `added` counts calls we reserved after the reading, which the provider hasn't
 *   reported yet. It's never decremented on release (cautious), and a new reading
 *   resets it.
 *
 * The Redis script and the Postgres function implement the same formulas.
 */
export interface Floor {
  used: number;
  until: number;
  at: number;
  drain: boolean;
  added: number;
}

/**
 * Whether a new reading replaces the current floor: always when the current one has
 * expired or is a draining estimate being replaced by a real header reading; otherwise
 * only when it isn't lower than what we already account for (out-of-order responses).
 */
export function replacesFloor(current: Floor | undefined, used: number, drain: boolean, now: number): boolean {
  if (!current || current.until <= now) return true;
  if (current.drain && !drain) return true;
  return used >= floorAt(current, now);
}

/** The reported part only, without `added`. */
export function readingAt(f: Floor | undefined, now: number): number {
  if (!f || f.until <= now) return 0;
  if (!f.drain || f.at >= f.until) return f.used;
  return (f.used * (f.until - now)) / (f.until - f.at);
}

export function floorAt(f: Floor | undefined, now: number): number {
  return !f || f.until <= now ? 0 : readingAt(f, now) + f.added;
}

/** How long until `need` more fits under `limit` as far as the floor is concerned. */
export function floorWait(f: Floor, now: number, need: number, limit: number): number {
  if (need > limit) return Infinity;
  const room = limit - need - f.added;
  if (!f.drain || f.at >= f.until || room < 0) return f.until - now;
  const fitsAt = f.until - (room * (f.until - f.at)) / f.used;
  return Math.min(f.until - now, Math.max(1, Math.ceil(fitsAt - now)));
}
