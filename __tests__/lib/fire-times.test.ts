import { describe, it, expect } from 'vitest';
import { fireTimesStr } from '@/lib/fire-times';

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
