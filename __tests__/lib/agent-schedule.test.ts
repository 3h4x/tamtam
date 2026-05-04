import { describe, expect, it } from 'vitest';
import {
  normalizeAgentScheduleOrThrow,
  parseOptionalAgentScheduleInput,
} from '@/lib/scheduling/agent-schedule';

describe('agent-schedule', () => {
  describe('parseOptionalAgentScheduleInput', () => {
    it('normalizes valid schedules by trimming and lowercasing', () => {
      expect(parseOptionalAgentScheduleInput(' 15M ')).toEqual({
        schedule: '15m',
        error: null,
      });
      expect(parseOptionalAgentScheduleInput(' 4H ')).toEqual({
        schedule: '4h',
        error: null,
      });
    });

    it('treats nullish and blank values as no schedule', () => {
      expect(parseOptionalAgentScheduleInput(null)).toEqual({
        schedule: null,
        error: null,
      });
      expect(parseOptionalAgentScheduleInput('   ')).toEqual({
        schedule: null,
        error: null,
      });
    });

    it('rejects non-string and unsupported values with a user-facing error', () => {
      expect(parseOptionalAgentScheduleInput(15)).toEqual({
        schedule: null,
        error: expect.stringContaining('Invalid schedule'),
      });
      expect(parseOptionalAgentScheduleInput('1w')).toEqual({
        schedule: null,
        error: expect.stringContaining('Invalid schedule'),
      });
    });
  });

  describe('normalizeAgentScheduleOrThrow', () => {
    it('returns the normalized schedule string', () => {
      expect(normalizeAgentScheduleOrThrow(' 24H ')).toBe('24h');
    });

    it('throws for blank or unsupported schedules', () => {
      expect(() => normalizeAgentScheduleOrThrow('   ')).toThrow('Invalid schedule');
      expect(() => normalizeAgentScheduleOrThrow('0m')).toThrow('Invalid schedule');
    });
  });
});
