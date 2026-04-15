import { describe, it, expect } from 'vitest';
import {
  parseFrequency,
  effectiveFreqMin,
  computeSchedule,
  parseCronTime,
  cronFiresStr,
} from '@/lib/scheduling';

describe('parseFrequency', () => {
  it('parses minutes', () => {
    expect(parseFrequency('10m')).toBe(10);
    expect(parseFrequency('90m')).toBe(90);
  });
  it('parses hours', () => {
    expect(parseFrequency('2h')).toBe(120);
    expect(parseFrequency('1h')).toBe(60);
  });
  it('parses raw number', () => {
    expect(parseFrequency('30')).toBe(30);
  });
});

describe('effectiveFreqMin', () => {
  const multipliers = { critical: 1, high: 2, medium: 4, low: 8 };

  it('applies multiplier', () => {
    expect(effectiveFreqMin('critical', multipliers, 60)).toBe(60);
    expect(effectiveFreqMin('high', multipliers, 60)).toBe(120);
    expect(effectiveFreqMin('medium', multipliers, 60)).toBe(240);
    expect(effectiveFreqMin('low', multipliers, 60)).toBe(480);
  });

  it('uses default for unknown priority', () => {
    expect(effectiveFreqMin('unknown', multipliers, 60)).toBe(240);
  });
});

describe('computeSchedule', () => {
  it('computes minute and cycle', () => {
    const result = computeSchedule(0, 60, 120);
    expect(result.minute).toBe(0);
    expect(result.cycleHours).toBe(2);
    expect(result.hourPhase).toBe(0);
  });

  it('staggers by tier index', () => {
    const r1 = computeSchedule(1, 30, 120);
    expect(r1.minute).toBe(30);
    expect(r1.hourPhase).toBe(0);

    const r2 = computeSchedule(2, 30, 120);
    expect(r2.minute).toBe(0);
    expect(r2.hourPhase).toBe(1);
  });
});

describe('parseCronTime', () => {
  it('parses simple daily cron', () => {
    const r = parseCronTime('30 2 * * *');
    expect(r).toEqual({ minute: 30, step: 0, start: 2, weekday: null });
  });

  it('parses */N hour step', () => {
    const r = parseCronTime('0 */3 * * *');
    expect(r).toEqual({ minute: 0, step: 3, start: 0, weekday: null });
  });

  it('parses S/N hour step', () => {
    const r = parseCronTime('15 1/4 * * *');
    expect(r).toEqual({ minute: 15, step: 4, start: 1, weekday: null });
  });

  it('parses weekday cron', () => {
    const r = parseCronTime('0 3 * * 1');
    expect(r).toEqual({ minute: 0, step: 0, start: 3, weekday: 1 });
  });
});

describe('cronFiresStr', () => {
  it('shows daily schedule', () => {
    expect(cronFiresStr('30 2 * * *')).toBe('daily 02:30');
  });

  it('shows hourly schedule', () => {
    expect(cronFiresStr('0 */1 * * *')).toBe('every 1h :00');
  });

  it('shows step schedule', () => {
    expect(cronFiresStr('15 */3 * * *')).toBe('every 3h +0h :15');
  });

  it('shows weekday schedule', () => {
    expect(cronFiresStr('0 3 * * 1')).toBe('Mon 03:00');
  });

  it('shows Sunday schedule', () => {
    expect(cronFiresStr('30 10 * * 0')).toBe('Sun 10:30');
  });
});
