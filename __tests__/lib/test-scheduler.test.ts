import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

describe('installTestSchedule / uninstallTestSchedule', () => {
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let installTestSchedule: typeof import('@/lib/scheduling/test-scheduler').installTestSchedule;
  let uninstallTestSchedule: typeof import('@/lib/scheduling/test-scheduler').uninstallTestSchedule;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-test-sched-'));
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tempDir };
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));

    const mod = await import('@/lib/scheduling/test-scheduler');
    installTestSchedule = mod.installTestSchedule;
    uninstallTestSchedule = mod.uninstallTestSchedule;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('installTestSchedule', () => {
    it('calls pm2 delete then pm2 start', async () => {
      await installTestSchedule('my-project', '30m');
      const calls = execMock.mock.calls.map(([cmd, args]: any) => ({ cmd, args }));
      const deleteCall = calls.find((c: { cmd: string; args: string[] }) => c.cmd === 'pm2' && c.args[0] === 'delete');
      const startCall = calls.find((c: { cmd: string; args: string[] }) => c.cmd === 'pm2' && c.args[0] === 'start');
      expect(deleteCall).toBeTruthy();
      expect(startCall).toBeTruthy();
      const deleteIdx = execMock.mock.calls.findIndex(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete');
      const startIdx = execMock.mock.calls.findIndex(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      expect(deleteIdx).toBeLessThan(startIdx);
    });

    it('names the pm2 job tamtam-test-{projectName}', async () => {
      await installTestSchedule('my-project', '1h');
      const startCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      expect(startCall?.[1]).toContain('tamtam-test-my-project');
    });

    it('passes the converted cron expression via --cron flag', async () => {
      await installTestSchedule('proj', '30m');
      const startCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const args: string[] = startCall?.[1] ?? [];
      const cronIdx = args.indexOf('--cron');
      expect(cronIdx).toBeGreaterThan(-1);
      expect(args[cronIdx + 1]).toBe('*/30 * * * *');
    });

    it('passes --no-autorestart to prevent initial immediate execution', async () => {
      await installTestSchedule('proj', '1h');
      const startCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      expect(startCall?.[1]).toContain('--no-autorestart');
    });

    it('writes a shell script file in the scripts dir', async () => {
      await installTestSchedule('my-project', '1h');
      const scriptsDir = join(tempDir, 'logs', 'test-scheduler');
      const scriptFile = join(scriptsDir, 'my-project.sh');
      expect(existsSync(scriptFile)).toBe(true);
    });

    it('script contains a curl POST to the project test endpoint', async () => {
      const { readFileSync } = await import('fs');
      await installTestSchedule('my-project', '1h');
      const scriptsDir = join(tempDir, 'logs', 'test-scheduler');
      const scriptFile = join(scriptsDir, 'my-project.sh');
      const content = readFileSync(scriptFile, 'utf-8');
      expect(content).toContain('curl');
      expect(content).toContain('POST');
      expect(content).toContain('my-project');
      expect(content).toContain('/test');
    });

    it('passes raw cron expression directly when given a 5-part cron', async () => {
      await installTestSchedule('proj', '0 9 * * 1');
      const startCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const args: string[] = startCall?.[1] ?? [];
      const cronIdx = args.indexOf('--cron');
      expect(args[cronIdx + 1]).toBe('0 9 * * 1');
    });
  });

  describe('uninstallTestSchedule', () => {
    it('calls pm2 delete with the correct job name', async () => {
      await uninstallTestSchedule('my-project');
      const deleteCall = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete');
      expect(deleteCall).toBeTruthy();
      expect(deleteCall?.[1]).toContain('tamtam-test-my-project');
    });

    it('removes the script file when it exists', async () => {
      const { writeFileSync, mkdirSync: mkdir } = await import('fs');
      const scriptsDir = join(tempDir, 'logs', 'test-scheduler');
      mkdir(scriptsDir, { recursive: true });
      const scriptFile = join(scriptsDir, 'my-project.sh');
      writeFileSync(scriptFile, '#!/bin/bash\necho hi\n');
      await uninstallTestSchedule('my-project');
      expect(existsSync(scriptFile)).toBe(false);
    });

    it('does not throw when script file does not exist', async () => {
      await expect(uninstallTestSchedule('nonexistent-project')).resolves.toBeUndefined();
    });

    it('does not throw when pm2 delete returns non-zero exit code', async () => {
      execMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'Process not found' });
      await expect(uninstallTestSchedule('proj')).resolves.toBeUndefined();
    });
  });
});
