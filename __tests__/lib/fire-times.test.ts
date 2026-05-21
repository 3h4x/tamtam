import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireTimesStr, stableHash, nextFireDisplay } from '@/lib/scheduling/fire-times';

describe('fireTimesStr', () => {
  describe('cycleHours <= 1 (hourly)', () => {
    it('returns every 1h format for cycleHours = 1', () => {
      const result = fireTimesStr(0, 1, 0);
      expect(result).toBe('every 1h :00');
    });

    it('pads minute with zero', () => {
      const result = fireTimesStr(0, 1, 5);
      expect(result).toBe('every 1h :05');
    });

    it('formats two-digit minute', () => {
      const result = fireTimesStr(0, 1, 30);
      expect(result).toBe('every 1h :30');
    });

    it('returns every 1h format for cycleHours = 0', () => {
      const result = fireTimesStr(0, 0, 15);
      expect(result).toBe('every 1h :15');
    });
  });

  describe('cycleHours > 1 (multi-hour)', () => {
    it('returns compressed format for cycleHours = 2 (many times exceed 18 chars)', () => {
      // cycleHours=2 produces 12 times which is > 18 chars, so compressed format
      const result = fireTimesStr(0, 2, 0);
      expect(result).toBe('every 2h +0h :00');
    });

    it('uses hour phase in compressed format', () => {
      const result = fireTimesStr(1, 2, 0);
      // Also produces many times > 18 chars → compressed
      expect(result).toBe('every 2h +1h :00');
    });

    it('formats minute with padding for 12h cycle', () => {
      const result = fireTimesStr(0, 12, 5);
      // Hours: 0, 12 → "0:05, 12:05" = 11 chars, fits in 18
      expect(result).toBe('0:05, 12:05');
    });

    it('returns exact string for 12h cycle with zero minute', () => {
      const result = fireTimesStr(0, 12, 0);
      // "0:00, 12:00" = 11 chars, fits in 18
      expect(result).toBe('0:00, 12:00');
    });

    it('compressed format includes hour phase', () => {
      const result = fireTimesStr(3, 4, 15);
      // Hours: 3, 7, 11, 15, 19, 23 → "3:15, 7:15, 11:15, 15:15, 19:15, 23:15" = 39 chars > 18
      expect(result).toBe('every 4h +3h :15');
    });

    it('returns exact times for 8h cycle', () => {
      const result = fireTimesStr(0, 8, 30);
      // Hours: 0, 8, 16 → "0:30, 8:30, 16:30" = 17 chars, fits in 18
      expect(result).toBe('0:30, 8:30, 16:30');
    });

    it('returns compressed for 6h cycle (output exceeds 18 chars)', () => {
      const result = fireTimesStr(0, 6, 0);
      // Hours: 0, 6, 12, 18 → "0:00, 6:00, 12:00, 18:00" = 24 chars > 18
      expect(result).toBe('every 6h +0h :00');
    });
  });
});

describe('stableHash', () => {
  it('returns a number within [0, mod)', () => {
    expect(stableHash('agent-x', 60)).toBeGreaterThanOrEqual(0);
    expect(stableHash('agent-x', 60)).toBeLessThan(60);
  });

  it('is deterministic for the same input', () => {
    expect(stableHash('agent-det', 24)).toBe(stableHash('agent-det', 24));
  });

  it('produces different values for different inputs', () => {
    expect(stableHash('alpha', 100)).not.toBe(stableHash('beta', 100));
  });

  it('returns 0 for empty string (empty loop, h stays 0)', () => {
    expect(stableHash('', 10)).toBe(0);
    expect(stableHash('', 1)).toBe(0);
  });

  it('result is always < mod regardless of large mod', () => {
    const result = stableHash('some-agent-id', 3600);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(3600);
  });

  it('known hash: stableHash("x:h", 2) = 0', () => {
    // 'x'=120 → h=120; ':'=58 → h=3778; 'h'=104 → h=117222; 117222%2=0
    expect(stableHash('x:h', 2)).toBe(0);
  });

  it('known hash: stableHash("x:min", 60) = 52', () => {
    // Computed: h after 'x:min' = 112658512; 112658512%60 = 52
    expect(stableHash('x:min', 60)).toBe(52);
  });
});

describe('nextFireDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string for sub-hour schedule', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('30m', 'agent-x')).toBe('');
    expect(nextFireDisplay('15m', 'agent-x')).toBe('');
    expect(nextFireDisplay('45m', 'agent-x')).toBe('');
  });

  it('returns empty string for empty schedule', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('', 'agent-x')).toBe('');
  });

  it('is deterministic for the same agentId and schedule', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('4h', 'agent-same')).toBe(nextFireDisplay('4h', 'agent-same'));
  });

  it('produces a "next in ..." string for hour-based schedule', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    const result = nextFireDisplay('2h', 'agent-x');
    expect(result).toMatch(/^next in (\d+m|\d+h \d+m)$/);
  });

  it('treats "120m" as 2h schedule and returns a fire time string', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    const from2h = nextFireDisplay('2h', 'agent-x');
    const from120m = nextFireDisplay('120m', 'agent-x');
    // Both use periodHours=2 and the same agentId so they resolve identically
    expect(from120m).toBe(from2h);
  });

  it('returns empty string for "59m" (periodHours stays 0)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('59m', 'agent-x')).toBe('');
  });

  it('uses known hash for agentId "x", "2h": fires at 00:52, 02:52, ...', () => {
    // stableHash('x:h', 2)=0, stableHash('x:min', 60)=52 → fires at 00:52, 02:52 ...
    // Set now to 00:00:00 — next fire is 00:52 → "next in 52m"
    vi.setSystemTime(new Date(2026, 0, 15, 0, 0, 0));
    expect(nextFireDisplay('2h', 'x')).toBe('next in 52m');
  });

  it('skips past candidates and finds next one later in the day', () => {
    // For agentId 'x', '2h': fires at 00:52, 02:52 ...
    // Set now to 01:00 — 00:52 already past, next is 02:52 → diffMin = 112 → "next in 1h 52m"
    vi.setSystemTime(new Date(2026, 0, 15, 1, 0, 0));
    expect(nextFireDisplay('2h', 'x')).toBe('next in 1h 52m');
  });

  it('falls back to tomorrow when all today slots are past', () => {
    // For agentId 'x', '2h': last slot is 22:52. Set now to 23:00.
    // All today's slots (00:52 ... 22:52) are in the past.
    // Tomorrow: startHour=0, minOff=52 → 2026-01-16 00:52
    // diffMin from 23:00 = 60+52 = 112 → "next in 1h 52m"
    vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));
    expect(nextFireDisplay('2h', 'x')).toBe('next in 1h 52m');
  });

  it('returns "next in Xm" when less than 60 min away', () => {
    // For agentId 'x', '2h': fires at 00:52. Set now to 00:20 → 32 min away
    vi.setSystemTime(new Date(2026, 0, 15, 0, 20, 0));
    expect(nextFireDisplay('2h', 'x')).toBe('next in 32m');
  });

  it('different agentIds produce valid output strings', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    const a = nextFireDisplay('4h', 'agent-alpha');
    const b = nextFireDisplay('4h', 'agent-beta-different');
    expect(a).toMatch(/^next in /);
    expect(b).toMatch(/^next in /);
  });

  it('returns "next in Nd" for day-suffix schedules (no redundant 0h)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('1d', 'agent-x')).toBe('next in 1d');
    expect(nextFireDisplay('3d', 'agent-x')).toBe('next in 3d');
    expect(nextFireDisplay('7d', 'agent-x')).toBe('next in 7d');
    expect(nextFireDisplay('30d', 'agent-x')).toBe('next in 30d');
  });

  it('returns empty string for invalid day schedules', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(nextFireDisplay('0d', 'agent-x')).toBe('');
    expect(nextFireDisplay('xd', 'agent-x')).toBe('');
  });
});
