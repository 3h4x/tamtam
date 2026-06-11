import { describe, expect, it, vi } from 'vitest';

describe('__tests__/setup-db-guard.ts', () => {
  it('restores real timers after tests use fake timers', () => {
    const realSetTimeout = setTimeout;

    vi.useFakeTimers();

    expect(setTimeout).not.toBe(realSetTimeout);
  });
});
