import type { Clock } from './types.js';

export const systemClock: Clock = { now: () => Date.now() };

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A manually driven clock for tests. */
export function fakeClock(start = 0): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}
