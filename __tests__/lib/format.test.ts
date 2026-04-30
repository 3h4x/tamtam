import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAgo } from '@/lib/shared/format';

describe('formatAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function now() {
    return Math.floor(Date.now() / 1000);
  }

  it('returns "just now" for 0 seconds ago', () => {
    expect(formatAgo(now())).toBe('just now');
  });

  it('returns "just now" for 59 seconds ago', () => {
    expect(formatAgo(now() - 59)).toBe('just now');
  });

  it('returns minutes for 60 seconds ago', () => {
    expect(formatAgo(now() - 60)).toBe('1m ago');
  });

  it('returns minutes for 90 seconds ago', () => {
    expect(formatAgo(now() - 90)).toBe('1m ago');
  });

  it('returns minutes for 3599 seconds ago', () => {
    expect(formatAgo(now() - 3599)).toBe('59m ago');
  });

  it('returns hours for exactly 1 hour ago', () => {
    expect(formatAgo(now() - 3600)).toBe('1h ago');
  });

  it('returns hours for 2 hours ago', () => {
    expect(formatAgo(now() - 7200)).toBe('2h ago');
  });

  it('returns hours for 23 hours ago', () => {
    expect(formatAgo(now() - 23 * 3600)).toBe('23h ago');
  });

  it('returns days for exactly 24 hours ago', () => {
    expect(formatAgo(now() - 86400)).toBe('1d ago');
  });

  it('returns days for 3 days ago', () => {
    expect(formatAgo(now() - 3 * 86400)).toBe('3d ago');
  });
});
