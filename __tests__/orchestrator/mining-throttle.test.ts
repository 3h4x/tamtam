import { describe, it, expect } from 'vitest';
import { shouldMineProject, markProjectMined } from '@/lib/orchestrator/mining-throttle';

describe('shouldMineProject', () => {
  const INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

  it('returns true for a never-mined project', () => {
    const map = new Map<string, number>();
    expect(shouldMineProject('my-project', Date.now(), map, INTERVAL_MS)).toBe(true);
  });

  it('returns false when within the interval', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('my-project', now - INTERVAL_MS + 1000); // 1s before threshold
    expect(shouldMineProject('my-project', now, map, INTERVAL_MS)).toBe(false);
  });

  it('returns true at exactly the interval boundary', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('my-project', now - INTERVAL_MS);
    expect(shouldMineProject('my-project', now, map, INTERVAL_MS)).toBe(true);
  });

  it('returns true after the interval has elapsed', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('my-project', now - INTERVAL_MS - 5000); // 5s past threshold
    expect(shouldMineProject('my-project', now, map, INTERVAL_MS)).toBe(true);
  });
});

describe('markProjectMined', () => {
  it('records the timestamp for the project', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    markProjectMined('my-project', now, map);
    expect(map.get('my-project')).toBe(now);
  });

  it('updates the timestamp on a second call', () => {
    const map = new Map<string, number>();
    const t1 = 1000;
    const t2 = 2000;
    markProjectMined('my-project', t1, map);
    markProjectMined('my-project', t2, map);
    expect(map.get('my-project')).toBe(t2);
  });
});
