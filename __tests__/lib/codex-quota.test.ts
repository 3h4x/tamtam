import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

describe('codex-quota', () => {
  it('returns only the newest session files without requiring pre-sorted directory entries', async () => {
    const { __private__ } = await import('@/lib/usage/codex-quota');
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-codex-quota-'));

    try {
      const nestedDir = join(tempDir, 'nested');
      mkdirSync(nestedDir);
      for (let i = 0; i < 25; i += 1) {
        const dir = i % 2 === 0 ? tempDir : nestedDir;
        const path = join(dir, `session-${String(24 - i).padStart(2, '0')}.jsonl`);
        writeFileSync(path, '{}\n');
        const mtime = new Date(Date.UTC(2026, 4, 2, 8, i));
        utimesSync(path, mtime, mtime);
      }
      writeFileSync(join(tempDir, 'ignore.txt'), '{}\n');

      const files = await __private__.listSessionFiles(tempDir);

      expect(files).toHaveLength(20);
      expect(files.map((file) => file.match(/session-(\d+)\.jsonl$/)?.[1])).toEqual([
        '00', '01', '02', '03', '04',
        '05', '06', '07', '08', '09',
        '10', '11', '12', '13', '14',
        '15', '16', '17', '18', '19',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('parses the latest token_count rate-limit event from a session log', async () => {
    const { __private__ } = await import('@/lib/usage/codex-quota');
    const content = [
      JSON.stringify({
        timestamp: '2026-05-02T06:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 10, window_minutes: 300, resets_at: 1777555951 },
            secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1778142243 },
            plan_type: 'plus',
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-02T06:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1777556000 },
            secondary: { used_percent: 4, window_minutes: 10080, resets_at: 1778142300 },
            plan_type: 'go',
          },
        },
      }),
    ].join('\n');

    const parsed = __private__.newestRateLimitsFromContent(content);

    expect(parsed?.primary?.used_percent).toBe(12);
    expect(parsed?.secondary?.used_percent).toBe(4);
    expect(parsed?.plan_type).toBe('go');
  });

  it('treats exhausted Codex credits as a hard quota block', async () => {
    const { __private__ } = await import('@/lib/usage/codex-quota');
    const snapshot = __private__.buildSnapshot({
      limit_id: 'premium',
      primary: null,
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: null,
      rate_limit_reached_type: null,
    }, Date.UTC(2026, 4, 2, 7, 45), false);

    expect(snapshot.provider).toBe('codex');
    expect(snapshot.planType).toBe('premium');
    expect(snapshot.fiveHour.utilization).toBe(100);
    expect(snapshot.extra?.utilization).toBe(100);
  });

  it('does not carry an older premium-credit block over newer rolling-window status', async () => {
    const { __private__ } = await import('@/lib/usage/codex-quota');
    const effective = __private__.selectEffectiveRateLimits([{
      limit_id: 'codex',
      primary: { used_percent: 5, window_minutes: 300, resets_at: 1777725844 },
      secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1778312644 },
      credits: null,
      plan_type: 'prolite',
      rate_limit_reached_type: null,
    }, {
      limit_id: 'premium',
      primary: null,
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: null,
      rate_limit_reached_type: null,
    }]);
    const snapshot = __private__.buildSnapshot(effective!, Date.UTC(2026, 4, 2, 8, 25), false);

    expect(snapshot.planType).toBe('prolite');
    expect(snapshot.fiveHour.utilization).toBe(5);
    expect(snapshot.fiveHour.resetsAt).toBe(new Date(1777725844 * 1000).toISOString());
    expect(snapshot.sevenDay.utilization).toBe(1);
    expect(snapshot.extra).toBeUndefined();
  });

  it('classifies Codex windows by window_minutes, not primary/secondary names', async () => {
    const { __private__ } = await import('@/lib/usage/codex-quota');
    const weeklyReset = 1778102871;
    const snapshot = __private__.buildSnapshot({
      limit_id: 'codex',
      primary: { used_percent: 17, window_minutes: 10080, resets_at: weeklyReset },
      secondary: null,
      credits: null,
      plan_type: 'go',
      rate_limit_reached_type: null,
    }, Date.UTC(2026, 4, 2, 8, 25), false);

    expect(snapshot.fiveHour.utilization).toBe(0);
    expect(snapshot.fiveHour.resetsAt).toBeNull();
    expect(snapshot.sevenDay.utilization).toBe(17);
    expect(snapshot.sevenDay.resetsAt).toBe(new Date(weeklyReset * 1000).toISOString());
  });
});
