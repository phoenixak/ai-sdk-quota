import { describe, expect, it } from 'vitest';
import { type Floor, floorAt, floorWait, readingAt, replacesFloor } from '../src/store/floor.js';

const flat: Floor = { used: 900, until: 10_000, at: 0, drain: false, added: 5 };
const draining: Floor = { used: 30, until: 61_000, at: 0, drain: true, added: 0 };

describe('floor', () => {
  it('holds a flat reading until it expires, plus calls added since', () => {
    expect(readingAt(flat, 5_000)).toBe(900);
    expect(floorAt(flat, 5_000)).toBe(905);
    expect(floorAt(flat, 10_000)).toBe(0);
    expect(floorAt(undefined, 0)).toBe(0);
    expect(readingAt(undefined, 0)).toBe(0);
  });

  it('drains a 429 reading linearly over the window', () => {
    expect(readingAt(draining, 0)).toBe(30);
    expect(readingAt(draining, 30_500)).toBe(15);
    expect(floorAt({ ...draining, added: 2 }, 30_500)).toBe(17);
    // A degenerate window (at >= until) holds flat.
    expect(readingAt({ ...draining, at: 61_000 }, 1)).toBe(30);
  });

  it('waits for exactly enough drain to fit the next call', () => {
    // limit 30, need 1: fits once 30 * (61000 - t) / 61000 <= 29, i.e. t >= 2033.3.
    expect(floorWait(draining, 0, 1, 30)).toBe(2_034);
    expect(floorWait(draining, 2_000, 1, 30)).toBe(34);
    expect(floorWait(draining, 0, 31, 30)).toBe(Infinity);
    // Calls added since the reading push the wait out; no room at all means the full reset.
    expect(floorWait({ ...draining, added: 1 }, 0, 1, 30)).toBe(4_067);
    expect(floorWait({ ...draining, added: 30 }, 0, 1, 30)).toBe(61_000);
    expect(floorWait(flat, 4_000, 1, 1_000)).toBe(6_000);
  });

  it('lets real readings replace estimates, but not lower stale readings', () => {
    expect(replacesFloor(undefined, 1, false, 0)).toBe(true);
    expect(replacesFloor(flat, 1, false, 10_000)).toBe(true);
    expect(replacesFloor(draining, 3, false, 1_000)).toBe(true);
    expect(replacesFloor(flat, 800, false, 1_000)).toBe(false);
    expect(replacesFloor(flat, 905, true, 1_000)).toBe(true);
  });
});
