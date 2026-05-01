import { describe, it, expect } from 'vitest';
import { runWithParent, currentParent } from '@/lib/jobs/parent-context';

describe('currentParent', () => {
  it('returns null outside any context', () => {
    expect(currentParent()).toBeNull();
  });
});

describe('runWithParent', () => {
  it('exposes parent id within the callback', async () => {
    let seen: string | null = null;
    await runWithParent('job-abc', async () => {
      seen = currentParent();
    });
    expect(seen).toBe('job-abc');
  });

  it('restores null after the callback resolves', async () => {
    await runWithParent('job-xyz', async () => {
      expect(currentParent()).toBe('job-xyz');
    });
    expect(currentParent()).toBeNull();
  });

  it('nests correctly — inner wins, outer restored after', async () => {
    let inner: string | null = null;
    let outer: string | null = null;
    await runWithParent('outer', async () => {
      outer = currentParent();
      await runWithParent('inner', async () => {
        inner = currentParent();
      });
      // after inner finishes, we should be back to outer context
      expect(currentParent()).toBe('outer');
    });
    expect(outer).toBe('outer');
    expect(inner).toBe('inner');
  });

  it('isolates concurrent contexts', async () => {
    const results: string[] = [];
    const a = runWithParent('job-a', () =>
      new Promise<void>((res) => setTimeout(() => { results.push(currentParent()!); res(); }, 10))
    );
    const b = runWithParent('job-b', () =>
      new Promise<void>((res) => setTimeout(() => { results.push(currentParent()!); res(); }, 5))
    );
    await Promise.all([a, b]);
    expect(results).toContain('job-a');
    expect(results).toContain('job-b');
  });

  it('works with sync callbacks', () => {
    const result = runWithParent('sync-job', () => currentParent());
    expect(result).toBe('sync-job');
  });
});
