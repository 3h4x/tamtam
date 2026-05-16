import { describe, it, expect } from 'vitest';
import { computeFixBackoffSeconds } from '@/lib/workflows/dispatch-phase';

describe('computeFixBackoffSeconds', () => {
  it('returns 0 when base is 0 (feature disabled)', () => {
    expect(computeFixBackoffSeconds(10, 0)).toBe(0);
  });

  it('returns 0 for iterations at or below the threshold (3)', () => {
    expect(computeFixBackoffSeconds(0, 30)).toBe(0);
    expect(computeFixBackoffSeconds(1, 30)).toBe(0);
    expect(computeFixBackoffSeconds(2, 30)).toBe(0);
    expect(computeFixBackoffSeconds(3, 30)).toBe(0);
  });

  it('doubles each iteration past the threshold', () => {
    expect(computeFixBackoffSeconds(4, 30)).toBe(30);   // 30 * 2^0
    expect(computeFixBackoffSeconds(5, 30)).toBe(60);   // 30 * 2^1
    expect(computeFixBackoffSeconds(6, 30)).toBe(120);  // 30 * 2^2
    expect(computeFixBackoffSeconds(7, 30)).toBe(240);  // 30 * 2^3
  });

  it('caps at 300 seconds (5 min)', () => {
    expect(computeFixBackoffSeconds(8, 30)).toBe(300);  // would be 480 → cap
    expect(computeFixBackoffSeconds(20, 30)).toBe(300);
    expect(computeFixBackoffSeconds(100, 30)).toBe(300);
  });

  it('respects custom base values', () => {
    expect(computeFixBackoffSeconds(4, 60)).toBe(60);
    expect(computeFixBackoffSeconds(5, 60)).toBe(120);
    expect(computeFixBackoffSeconds(6, 60)).toBe(240);
    expect(computeFixBackoffSeconds(7, 60)).toBe(300);  // 480 → cap
  });

  it('respects a base larger than the cap', () => {
    expect(computeFixBackoffSeconds(4, 600)).toBe(300);
  });
});
