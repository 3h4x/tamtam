import { describe, expect, it } from 'vitest';
import { accumulateRunTokens } from '@/lib/jobs/run-token-usage';
import {
  evaluateRunCap,
  isRunCapEligibleKind,
  RUN_TOKEN_CAP_EXIT_CODE,
  RUN_WALL_TIME_EXIT_CODE,
} from '@/lib/jobs/run-cap-reaper';

function assistantLine(usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { usage } });
}

describe('accumulateRunTokens', () => {
  it('sums input + output + cache-creation across turns, EXCLUDING cache reads', () => {
    const log = [
      assistantLine({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }),
      assistantLine({ input_tokens: 200, output_tokens: 80 }),
    ].join('\n');
    // (100+50+5) + (200+80) = 155 + 280 = 435 — cache_read (10) is NOT counted.
    expect(accumulateRunTokens(log)).toBe(435);
  });

  it('does not let re-read cached context inflate the total (the false-runaway bug)', () => {
    // A cheap multi-turn run: tiny real spend, huge cache_read from re-reading
    // the same cached system prompt every turn. The cap must see the real spend
    // (30), not the 3,000,000 cache-read sum that used to trip the 2M cap.
    const log = Array.from({ length: 3 }, () =>
      assistantLine({ input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 1_000_000 }),
    ).join('\n');
    expect(accumulateRunTokens(log)).toBe(30);
  });

  it('ignores non-assistant lines and unparseable garbage', () => {
    const log = [
      '{"type":"system","subtype":"status","status":"compacting"}',
      'not json at all',
      assistantLine({ input_tokens: 10, output_tokens: 5 }),
      '{"type":"result","modelUsage":{"opus":{"outputTokens":9999}}}',
    ].join('\n');
    expect(accumulateRunTokens(log)).toBe(15);
  });

  it('tolerates PM2 ISO timestamp prefixes', () => {
    const log = `2026-04-22T12:51:05: ${assistantLine({ input_tokens: 7, output_tokens: 3 })}`;
    expect(accumulateRunTokens(log)).toBe(10);
  });

  it('returns 0 for empty or missing usage', () => {
    expect(accumulateRunTokens('')).toBe(0);
    expect(accumulateRunTokens('{"type":"assistant","message":{}}')).toBe(0);
  });
});

describe('isRunCapEligibleKind', () => {
  it('covers Claude runs and agents', () => {
    expect(isRunCapEligibleKind('run')).toBe(true);
    expect(isRunCapEligibleKind('review')).toBe(true);
    expect(isRunCapEligibleKind('fix')).toBe(true);
    expect(isRunCapEligibleKind('agent:issue-cruncher')).toBe(true);
  });

  it('excludes the dedicated-cap and non-Claude kinds', () => {
    expect(isRunCapEligibleKind('test')).toBe(false);
    expect(isRunCapEligibleKind('mark-dod-verify')).toBe(false);
    expect(isRunCapEligibleKind('release')).toBe(false);
    expect(isRunCapEligibleKind('commit')).toBe(false);
    expect(isRunCapEligibleKind('push')).toBe(false);
  });
});

describe('evaluateRunCap', () => {
  const now = 10_000_000; // ms
  const cfg = { tokenCap: 1_000_000, wallMinutes: 30 };

  it('flags a wall-time violation with the wall-time exit code', () => {
    const startedAt = (now - 31 * 60_000) / 1000; // 31 min ago, in seconds
    const v = evaluateRunCap({ kind: 'run', startedAt }, now, 0, cfg);
    expect(v?.exitCode).toBe(RUN_WALL_TIME_EXIT_CODE);
    expect(v?.reason).toContain('wall-time');
  });

  it('flags a token violation with the token exit code', () => {
    const startedAt = (now - 60_000) / 1000; // 1 min ago — under wall cap
    const v = evaluateRunCap({ kind: 'run', startedAt }, now, 1_500_000, cfg);
    expect(v?.exitCode).toBe(RUN_TOKEN_CAP_EXIT_CODE);
    expect(v?.reason).toContain('token');
  });

  it('checks wall-time before tokens when both blow', () => {
    const startedAt = (now - 31 * 60_000) / 1000;
    const v = evaluateRunCap({ kind: 'run', startedAt }, now, 9_000_000, cfg);
    expect(v?.exitCode).toBe(RUN_WALL_TIME_EXIT_CODE);
  });

  it('returns null when under both caps', () => {
    const startedAt = (now - 60_000) / 1000;
    expect(evaluateRunCap({ kind: 'run', startedAt }, now, 10, cfg)).toBeNull();
  });

  it('is a no-op for ineligible kinds even when over cap', () => {
    const startedAt = (now - 999 * 60_000) / 1000;
    expect(evaluateRunCap({ kind: 'test', startedAt }, now, 9_000_000, cfg)).toBeNull();
    expect(evaluateRunCap({ kind: 'release', startedAt }, now, 9_000_000, cfg)).toBeNull();
  });

  it('respects the disabled sentinels (0)', () => {
    const startedAt = (now - 999 * 60_000) / 1000;
    const disabled = { tokenCap: 0, wallMinutes: 0 };
    expect(evaluateRunCap({ kind: 'run', startedAt }, now, 9_000_000, disabled)).toBeNull();
  });
});
