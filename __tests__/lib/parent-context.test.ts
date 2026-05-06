import { describe, it, expect } from 'vitest';
import { currentParent, runWithParent } from '@/lib/jobs/parent-context';

describe('parent-context (AsyncLocalStorage)', () => {
  it('currentParent returns null outside any runWithParent call', () => {
    expect(currentParent()).toBeNull();
  });

  it('currentParent returns the active parent id inside runWithParent', () => {
    let captured: string | null = null;
    runWithParent('job-42', () => {
      captured = currentParent();
    });
    expect(captured).toBe('job-42');
  });

  it('currentParent returns null again after runWithParent callback returns', () => {
    runWithParent('job-1', () => {});
    expect(currentParent()).toBeNull();
  });

  it('runWithParent works with async callbacks and propagates context across awaits', async () => {
    let captured: string | null = null;
    await runWithParent('job-async', async () => {
      await Promise.resolve();
      captured = currentParent();
    });
    expect(captured).toBe('job-async');
    // After the async completion, context is no longer active in the outer frame
    expect(currentParent()).toBeNull();
  });

  it('inner runWithParent shadows the outer parent id for nested calls', () => {
    let outerCapture: string | null = null;
    let innerCapture: string | null = null;
    let afterInnerCapture: string | null = null;

    runWithParent('outer', () => {
      outerCapture = currentParent();
      runWithParent('inner', () => {
        innerCapture = currentParent();
      });
      afterInnerCapture = currentParent();
    });

    expect(outerCapture).toBe('outer');
    expect(innerCapture).toBe('inner');
    expect(afterInnerCapture).toBe('outer');
  });

  it('concurrent async contexts do not interfere with each other', async () => {
    const results: Array<{ id: string; captured: string | null }> = [];

    await Promise.all(
      ['job-A', 'job-B', 'job-C'].map(async (id) => {
        await runWithParent(id, async () => {
          // Yield to let other async tasks run
          await new Promise((r) => setTimeout(r, 0));
          results.push({ id, captured: currentParent() });
        });
      }),
    );

    for (const { id, captured } of results) {
      expect(captured).toBe(id);
    }
  });

  it('runWithParent returns the value produced by the callback (sync)', () => {
    const result = runWithParent('job-x', () => 'returned-value');
    expect(result).toBe('returned-value');
  });

  it('runWithParent returns the promise produced by an async callback', async () => {
    const result = await runWithParent('job-y', async () => 99);
    expect(result).toBe(99);
  });
});
