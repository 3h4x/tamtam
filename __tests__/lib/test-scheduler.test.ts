import { describe, it, expect } from 'vitest';
import { parseTestScheduleToCron } from '@/lib/test-scheduler';

describe('parseTestScheduleToCron', () => {
  describe('minute intervals', () => {
    it('converts 30m to */30 cron', () => {
      expect(parseTestScheduleToCron('30m')).toBe('*/30 * * * *');
    });

    it('converts 5m to */5 cron', () => {
      expect(parseTestScheduleToCron('5m')).toBe('*/5 * * * *');
    });

    it('converts 1m to */1 cron', () => {
      expect(parseTestScheduleToCron('1m')).toBe('*/1 * * * *');
    });

    it('converts 59m to */59 cron', () => {
      expect(parseTestScheduleToCron('59m')).toBe('*/59 * * * *');
    });

    it('converts 60m (1 hour) to 0 */1 cron', () => {
      expect(parseTestScheduleToCron('60m')).toBe('0 */1 * * *');
    });

    it('converts 120m (2 hours) to 0 */2 cron', () => {
      expect(parseTestScheduleToCron('120m')).toBe('0 */2 * * *');
    });

    it('trims whitespace before parsing', () => {
      expect(parseTestScheduleToCron('  30m  ')).toBe('*/30 * * * *');
    });

    it('throws for 0m', () => {
      expect(() => parseTestScheduleToCron('0m')).toThrow('Invalid schedule');
    });

    it('throws for negative minutes', () => {
      expect(() => parseTestScheduleToCron('-5m')).toThrow('Invalid schedule');
    });

    it('throws for non-numeric minutes', () => {
      expect(() => parseTestScheduleToCron('abcm')).toThrow('Invalid schedule');
    });
  });

  describe('hour intervals', () => {
    it('converts 1h to 0 */1 cron', () => {
      expect(parseTestScheduleToCron('1h')).toBe('0 */1 * * *');
    });

    it('converts 6h to 0 */6 cron', () => {
      expect(parseTestScheduleToCron('6h')).toBe('0 */6 * * *');
    });

    it('converts 12h to 0 */12 cron', () => {
      expect(parseTestScheduleToCron('12h')).toBe('0 */12 * * *');
    });

    it('throws for 0h', () => {
      expect(() => parseTestScheduleToCron('0h')).toThrow('Invalid schedule');
    });

    it('throws for negative hours', () => {
      expect(() => parseTestScheduleToCron('-1h')).toThrow('Invalid schedule');
    });
  });

  describe('day intervals', () => {
    it('converts 1d to daily at midnight', () => {
      expect(parseTestScheduleToCron('1d')).toBe('0 0 * * *');
    });

    it('converts 2d to 0 0 */2 cron', () => {
      expect(parseTestScheduleToCron('2d')).toBe('0 0 */2 * *');
    });

    it('converts 7d to 0 0 */7 cron', () => {
      expect(parseTestScheduleToCron('7d')).toBe('0 0 */7 * *');
    });

    it('throws for 0d', () => {
      expect(() => parseTestScheduleToCron('0d')).toThrow('Invalid schedule');
    });

    it('throws for negative days', () => {
      expect(() => parseTestScheduleToCron('-1d')).toThrow('Invalid schedule');
    });
  });

  describe('raw cron expressions', () => {
    it('passes through a valid 5-part cron expression', () => {
      expect(parseTestScheduleToCron('0 9 * * 1')).toBe('0 9 * * 1');
    });

    it('passes through */15 * * * *', () => {
      expect(parseTestScheduleToCron('*/15 * * * *')).toBe('*/15 * * * *');
    });

    it('passes through 0 0 1 * *', () => {
      expect(parseTestScheduleToCron('0 0 1 * *')).toBe('0 0 1 * *');
    });
  });

  describe('invalid inputs', () => {
    it('throws for empty string', () => {
      expect(() => parseTestScheduleToCron('')).toThrow('Invalid schedule');
    });

    it('throws for plain number with no unit', () => {
      expect(() => parseTestScheduleToCron('30')).toThrow('Invalid schedule');
    });

    it('throws for unknown unit suffix', () => {
      expect(() => parseTestScheduleToCron('30s')).toThrow('Invalid schedule');
    });

    it('throws for 4-part cron expression', () => {
      expect(() => parseTestScheduleToCron('* * * *')).toThrow('Invalid schedule');
    });

    it('throws for 6-part cron expression', () => {
      expect(() => parseTestScheduleToCron('0 0 * * * *')).toThrow('Invalid schedule');
    });
  });
});
