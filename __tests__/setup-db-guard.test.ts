import { describe, expect, it, vi } from 'vitest';

describe('__tests__/setup-db-guard.ts', () => {
  const realSetTimeout = setTimeout;

  it('restores real timers after tests use fake timers', () => {
    vi.useFakeTimers();

    expect(setTimeout).not.toBe(realSetTimeout);
  });

  it('starts the next test with real timers restored', () => {
    expect(setTimeout).toBe(realSetTimeout);
  });
});
