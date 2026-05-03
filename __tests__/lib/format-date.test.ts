import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtAbsolute } from '@/lib/shared/format-date';

describe('fmtAbsolute', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels timestamps from the current day as today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T09:00:00.000Z'));

    expect(fmtAbsolute(Date.parse('2026-05-02T16:30:00.000Z'))).toMatch(/^today /);
  });

  it('labels timestamps from the next calendar day as tomorrow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T09:00:00.000Z'));

    expect(fmtAbsolute(Date.parse('2026-05-03T07:15:00.000Z'))).toMatch(/^tomorrow /);
  });

  it('falls back to a dated label after tomorrow', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T09:00:00.000Z'));

    const label = fmtAbsolute(Date.parse('2026-05-05T12:00:00.000Z'));

    expect(label).not.toMatch(/^(today|tomorrow) /);
    expect(label).toContain('May');
    expect(label).toContain('5');
  });
});
