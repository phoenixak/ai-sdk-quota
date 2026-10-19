/**
 * Adaptive limits, shared through the store so that one provider 429 lowers a limit
 * once for every instance. A record holds the factor set by the last lowering and
 * when; the factor climbs back linearly to 1 over `recoverMs`. Lowering is debounced:
 * several instances seeing 429s from the same burst lower it once, not once each.
 *
 * The Redis script and the Postgres function implement the same rules.
 */
export interface AdaptOptions {
  /** Multiplier applied on a 429, e.g. 0.75. */
  step: number;
  /** Lowest factor, e.g. 0.25. */
  min: number;
  recoverMs: number;
  /** Lowerings within this long of the last one are ignored. */
  debounceMs: number;
}

export interface Adapted {
  factor: number;
  at: number;
}

export function recovered(a: Adapted | undefined, now: number, recoverMs: number): number {
  if (!a) return 1;
  // Another instance's clock may be ahead: never treat negative elapsed time as anything but 0.
  return Math.min(1, a.factor + (Math.max(0, now - a.at) / recoverMs) * (1 - a.factor));
}

/** The record after a 429, and whether it changed (it doesn't inside the debounce window). */
export function lowered(
  a: Adapted | undefined,
  now: number,
  options: AdaptOptions,
): { record: Adapted; factor: number; changed: boolean } {
  const current = recovered(a, now, options.recoverMs);
  if (a && now - a.at < options.debounceMs) return { record: a, factor: current, changed: false };
  const factor = Math.max(options.min, current * options.step);
  return { record: { factor, at: now }, factor, changed: true };
}
