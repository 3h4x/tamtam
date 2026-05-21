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

  it('propagates context across an explicit await boundary', async () => {
    // Tightens the async coverage: not just that the callback sees the
    // context, but that the binding survives a yield to the microtask
    // queue (the realistic shape inside an async pipeline step).
    let captured: string | null = null;
    await runWithParent('await-job', async () => {
      await Promise.resolve();
      captured = currentParent();
    });
    expect(captured).toBe('await-job');
    expect(currentParent()).toBeNull();
  });

  it('returns the promise produced by an async callback', async () => {
    // Ensures `runWithParent` forwards the callback's resolved value
    // rather than swallowing it — callers rely on this in start-* paths.
    const result = await runWithParent('value-job', async () => 99);
    expect(result).toBe(99);
  });
});
