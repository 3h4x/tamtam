import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('parseTestScheduleToCron', () => {
  let parseTestScheduleToCron: typeof import('@/lib/scheduling/test-scheduler').parseTestScheduleToCron;

  beforeAll(async () => {
    // Import the real implementation, bypassing the module-scope mock for
    // `@/lib/scheduling/test-scheduler` in this file.
    const mod = await vi.importActual<typeof import('@/lib/scheduling/test-scheduler')>(
      '@/lib/scheduling/test-scheduler'
    );
    parseTestScheduleToCron = mod.parseTestScheduleToCron;
  });

  it('converts 30m to every-30-minute cron', () => {
    expect(parseTestScheduleToCron('30m')).toBe('*/30 * * * *');
  });

  it('converts 1h to hourly cron', () => {
    expect(parseTestScheduleToCron('1h')).toBe('0 */1 * * *');
  });

  it('converts 6h to every-6-hour cron', () => {
    expect(parseTestScheduleToCron('6h')).toBe('0 */6 * * *');
  });

  it('converts 1d to daily cron at midnight', () => {
    expect(parseTestScheduleToCron('1d')).toBe('0 0 * * *');
  });

  it('passes through a raw cron expression with five parts', () => {
    expect(parseTestScheduleToCron('15 3 * * 1')).toBe('15 3 * * 1');
  });

  it('throws on unknown format', () => {
    expect(() => parseTestScheduleToCron('abc')).toThrow(/Invalid schedule/);
  });

  it('throws on non-positive duration', () => {
    expect(() => parseTestScheduleToCron('0m')).toThrow(/Invalid schedule/);
  });
});

describe('GET /api/health', () => {
  it('returns status ok', async () => {
    const mod = await import('@/app/api/health/route');
    const res = await mod.GET(new NextRequest('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });
});
