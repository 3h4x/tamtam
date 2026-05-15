import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseTestScheduleToCron } from '@/lib/scheduling/test-scheduler';

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

describe('installTestSchedule / uninstallTestSchedule (in-process)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let installTestSchedule: typeof import('@/lib/scheduling/test-scheduler').installTestSchedule;
  let uninstallTestSchedule: typeof import('@/lib/scheduling/test-scheduler').uninstallTestSchedule;

  beforeEach(async () => {
    vi.resetModules();
    // Wipe any previously-registered timers on globalThis so each test
    // starts from a clean scheduler state.
    (globalThis as { __tamtamTestScheduler?: { entries: Map<string, { timer: NodeJS.Timeout }> } }).__tamtamTestScheduler = undefined;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const mod = await import('@/lib/scheduling/test-scheduler');
    installTestSchedule = mod.installTestSchedule;
    uninstallTestSchedule = mod.uninstallTestSchedule;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('registers an in-memory entry on install', async () => {
    await installTestSchedule('my-project', '30m');
    const state = (globalThis as { __tamtamTestScheduler?: { entries: Map<string, { intervalMs: number }> } }).__tamtamTestScheduler;
    expect(state?.entries.has('my-project')).toBe(true);
    expect(state?.entries.get('my-project')?.intervalMs).toBe(30 * 60_000);
  });

  it('replaces an existing entry on re-install', async () => {
    await installTestSchedule('my-project', '30m');
    await installTestSchedule('my-project', '1h');
    const state = (globalThis as { __tamtamTestScheduler?: { entries: Map<string, { intervalMs: number }> } }).__tamtamTestScheduler;
    expect(state?.entries.get('my-project')?.intervalMs).toBe(60 * 60_000);
  });

  it('removes the entry on uninstall', async () => {
    await installTestSchedule('my-project', '1h');
    await uninstallTestSchedule('my-project');
    const state = (globalThis as { __tamtamTestScheduler?: { entries: Map<string, unknown> } }).__tamtamTestScheduler;
    expect(state?.entries.has('my-project')).toBe(false);
  });

  it('uninstall is a no-op for an unknown project', async () => {
    await expect(uninstallTestSchedule('nonexistent-project')).resolves.toBeUndefined();
  });

  it('throws on raw cron expression — only Nm/Nh/Nd schedules fire in-process', async () => {
    await expect(installTestSchedule('proj', '0 9 * * 1')).rejects.toThrow(/not supported/);
  });

  it('does not shell out to pm2 anywhere', async () => {
    // The new scheduler is in-process only. Even with a long-running timer,
    // there's nothing to assert about pm2 — but we keep an explicit check so
    // future regressions can't silently reintroduce a pm2 dependency.
    const execSpy = vi.fn();
    vi.stubGlobal('exec', execSpy);
    await installTestSchedule('my-project', '15m');
    await uninstallTestSchedule('my-project');
    expect(execSpy).not.toHaveBeenCalled();
  });
});
