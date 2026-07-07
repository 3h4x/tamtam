import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '@/lib/shared/concurrency';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('preserves input order in the output regardless of settle order', async () => {
    // Later items resolve sooner, so an order-insensitive impl would scramble.
    const out = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
      await tick((5 - n) * 3);
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it('never runs more than `limit` invocations at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(4);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it('returns [] for empty input without invoking fn', async () => {
    let called = false;
    const out = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('caps workers at item count when limit exceeds length', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2], 100, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(4);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('treats a limit below 1 as a single worker (serial)', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(3);
      active -= 1;
    });
    expect(peak).toBe(1);
  });

  it('propagates the first rejection like Promise.all', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
