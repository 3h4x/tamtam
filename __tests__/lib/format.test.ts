import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAgo, formatTimeAgo } from '@/lib/shared/format';

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

describe('formatTimeAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function isoSecondsAgo(s: number): string {
    return new Date(Date.now() - s * 1000).toISOString();
  }

  it('returns "<1m" for sub-minute durations', () => {
    expect(formatTimeAgo(isoSecondsAgo(0))).toBe('<1m');
    expect(formatTimeAgo(isoSecondsAgo(59))).toBe('<1m');
  });

  it('returns compact minutes between 1m and 60m', () => {
    expect(formatTimeAgo(isoSecondsAgo(60))).toBe('1m');
    expect(formatTimeAgo(isoSecondsAgo(90))).toBe('1m');
    expect(formatTimeAgo(isoSecondsAgo(3599))).toBe('59m');
  });

  it('returns compact hours between 1h and 24h', () => {
    expect(formatTimeAgo(isoSecondsAgo(3600))).toBe('1h');
    expect(formatTimeAgo(isoSecondsAgo(23 * 3600))).toBe('23h');
  });

  it('returns compact days at or above 24h', () => {
    expect(formatTimeAgo(isoSecondsAgo(86400))).toBe('1d');
    expect(formatTimeAgo(isoSecondsAgo(3 * 86400))).toBe('3d');
  });

  it('treats future timestamps as "<1m" (no negative output)', () => {
    expect(formatTimeAgo(new Date(Date.now() + 60_000).toISOString())).toBe('<1m');
  });
});
