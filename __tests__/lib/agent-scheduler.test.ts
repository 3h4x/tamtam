import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('agent-scheduler', () => {
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let installAgentSchedule: typeof import('@/lib/agent-scheduler').installAgentSchedule;
  let uninstallAgentSchedule: typeof import('@/lib/agent-scheduler').uninstallAgentSchedule;
  let isAgentScheduleLoaded: typeof import('@/lib/agent-scheduler').isAgentScheduleLoaded;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-scheduler-test-'));
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tempDir };
    });

    vi.doMock('@/lib/shell', () => ({
      exec: execMock,
    }));

    vi.doMock('@/lib/config', () => ({
      getSettings: vi.fn().mockReturnValue({ launchagent_prefix: 'com.test' }),
    }));

    const mod = await import('@/lib/agent-scheduler');
    installAgentSchedule = mod.installAgentSchedule;
    uninstallAgentSchedule = mod.uninstallAgentSchedule;
    isAgentScheduleLoaded = mod.isAgentScheduleLoaded;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('installAgentSchedule (pm2)', () => {
    it('calls pm2 start with agent name', async () => {
      await installAgentSchedule('agent-abc', '30m', 'run tests', 'pm2');
      const calls = execMock.mock.calls.map(([cmd, args]: any) => ({
        cmd,
        args,
      }));
      const pm2Start = calls.find(c => c.cmd === 'pm2' && c.args[0] === 'start');
      expect(pm2Start).toBeTruthy();
      expect(pm2Start!.args).toContain('tamtam-agent-agent-abc');
    });

    it('calls pm2 delete before start (uninstall existing)', async () => {
      await installAgentSchedule('agent-abc', '1h', 'hello', 'pm2');
      const calls = execMock.mock.calls.map(([cmd, args]: any) => ({
        cmd,
        args,
      }));
      const pm2Delete = calls.find(c => c.cmd === 'pm2' && c.args[0] === 'delete');
      const pm2Start = calls.find(c => c.cmd === 'pm2' && c.args[0] === 'start');
      expect(pm2Delete).toBeTruthy();
      expect(pm2Start).toBeTruthy();
      // delete should come before start
      const deleteIdx = execMock.mock.calls.findIndex(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete'
      );
      const startIdx = execMock.mock.calls.findIndex(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      expect(deleteIdx).toBeLessThan(startIdx);
    });

    it('registers with --no-autostart to prevent initial execution', async () => {
      await installAgentSchedule('agent-abc', '1h', 'hello', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      expect(startCall).toBeTruthy();
      expect(startCall![1]).toContain('--no-autostart');
    });

    it('writes script file to disk', async () => {
      await installAgentSchedule('agent-xyz', '5m', 'my prompt', 'pm2');
      const scriptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-xyz.sh');
      expect(existsSync(scriptPath)).toBe(true);
    });

    it('writes prompt json file to disk', async () => {
      await installAgentSchedule('agent-xyz', '10m', 'my prompt here', 'pm2');
      const promptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-xyz.prompt.json');
      expect(existsSync(promptPath)).toBe(true);
      const content = JSON.parse(readFileSync(promptPath, 'utf-8'));
      expect(content.prompt).toBe('my prompt here');
    });

    it('script contains correct agent URL', async () => {
      await installAgentSchedule('agent-url-test', '1h', 'prompt', 'pm2');
      const scriptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-url-test.sh');
      const script = readFileSync(scriptPath, 'utf-8');
      expect(script).toContain('/api/agents/agent-url-test/run');
    });

    it('uses cron expression for pm2', async () => {
      await installAgentSchedule('agent-cron', '30m', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      expect(startCall).toBeTruthy();
      const args: string[] = startCall![1];
      const cronIdx = args.indexOf('--cron');
      expect(cronIdx).toBeGreaterThan(-1);
      expect(args[cronIdx + 1]).toBe('*/30 * * * *');
    });

    it('converts hours to cron expression with per-agent offset', async () => {
      await installAgentSchedule('agent-hourly', '2h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cronIdx = args.indexOf('--cron');
      // Format: `{minute} {startHour}/2 * * *` — deterministic offset from agent ID
      expect(args[cronIdx + 1]).toMatch(/^\d+ \d+\/2 \* \* \*$/);
    });

    it('different agentIds produce different cron schedules for same interval', async () => {
      await installAgentSchedule('agent-alpha', '4h', 'prompt', 'pm2');
      const call1 = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const cronA = call1![1][call1![1].indexOf('--cron') + 1];
      execMock.mockClear();

      await installAgentSchedule('agent-beta', '4h', 'prompt', 'pm2');
      const call2 = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const cronB = call2![1][call2![1].indexOf('--cron') + 1];

      expect(cronA).toMatch(/^\d+ \d+\/4 \* \* \*$/);
      expect(cronB).toMatch(/^\d+ \d+\/4 \* \* \*$/);
      expect(cronA).not.toBe(cronB);
    });

    it('converts minutes >= 60 to cron expression with per-agent offset', async () => {
      await installAgentSchedule('agent-120m', '120m', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cronIdx = args.indexOf('--cron');
      // 120m = 2 hours, should use per-agent offset like an hours schedule
      expect(args[cronIdx + 1]).toMatch(/^\d+ \d+\/2 \* \* \*$/);
    });

    it('same agentId always produces the same cron (deterministic hash)', async () => {
      await installAgentSchedule('agent-det', '3h', 'prompt', 'pm2');
      const call1 = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const cron1 = call1![1][call1![1].indexOf('--cron') + 1];
      execMock.mockClear();

      await installAgentSchedule('agent-det', '3h', 'prompt', 'pm2');
      const call2 = execMock.mock.calls.find(([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start');
      const cron2 = call2![1][call2![1].indexOf('--cron') + 1];

      expect(cron1).toBe(cron2);
    });

    it('cron minute offset is within valid cron range [0, 59]', async () => {
      await installAgentSchedule('agent-min-range', '6h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      const minute = parseInt(cron.split(' ')[0]);
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThan(60);
    });

    it('cron start hour is within valid range for the interval (< interval)', async () => {
      await installAgentSchedule('agent-hour-range', '4h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      // format: "{minute} {startHour}/4 * * *"
      const [startHour] = cron.split(' ')[1].split('/').map(Number);
      expect(startHour).toBeGreaterThanOrEqual(0);
      expect(startHour).toBeLessThan(4);
    });

    it('sub-minute schedule is not affected by agentId offset', async () => {
      await installAgentSchedule('agent-submin', '30m', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      // < 60 min schedules use simple */N form, no per-agent offset
      expect(cron).toBe('*/30 * * * *');
    });

    it('converts 72h to a day-of-month cron (*/3) so hour field stays valid', async () => {
      await installAgentSchedule('agent-72h', '72h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      // Must use day-of-month field: "{min} {hour} */3 * *"
      expect(cron).toMatch(/^\d+ \d+ \*\/3 \* \*$/);
      // Hour step must be absent from the hour field (no /N > 24)
      const parts = cron.split(' ');
      expect(parts[1]).not.toContain('/');
    });

    it('converts 168h to a day-of-month cron (*/7)', async () => {
      await installAgentSchedule('agent-168h', '168h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      expect(cron).toMatch(/^\d+ \d+ \*\/7 \* \*$/);
    });

    it('24h schedule still uses hour-field step (boundary)', async () => {
      await installAgentSchedule('agent-24h', '24h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cron = args[args.indexOf('--cron') + 1];
      // 24h is the boundary — still expressible in the hour field
      expect(cron).toMatch(/^\d+ \d+\/24 \* \* \*$/);
    });
  });

  describe('uninstallAgentSchedule (pm2)', () => {
    it('calls pm2 delete', async () => {
      await uninstallAgentSchedule('agent-to-remove', 'pm2');
      const deleteCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete'
      );
      expect(deleteCall).toBeTruthy();
      expect(deleteCall![1]).toContain('tamtam-agent-agent-to-remove');
    });

    it('cleans up script and prompt files', async () => {
      // First install to create files
      await installAgentSchedule('agent-cleanup', '1h', 'prompt', 'pm2');
      execMock.mockClear();
      const scriptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-cleanup.sh');
      const promptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-cleanup.prompt.json');
      expect(existsSync(scriptPath)).toBe(true);
      expect(existsSync(promptPath)).toBe(true);

      await uninstallAgentSchedule('agent-cleanup', 'pm2');

      expect(existsSync(scriptPath)).toBe(false);
      expect(existsSync(promptPath)).toBe(false);
    });

    it('does not throw if agent files do not exist', async () => {
      await expect(uninstallAgentSchedule('nonexistent-agent', 'pm2')).resolves.not.toThrow();
    });
  });

  describe('isAgentScheduleLoaded (pm2)', () => {
    it('returns true when pm2 describe exits 0', async () => {
      execMock.mockResolvedValue({ exitCode: 0, stdout: 'online', stderr: '' });
      const loaded = await isAgentScheduleLoaded('agent-running', 'pm2');
      expect(loaded).toBe(true);
    });

    it('returns false when pm2 describe exits non-zero', async () => {
      execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
      const loaded = await isAgentScheduleLoaded('agent-missing', 'pm2');
      expect(loaded).toBe(false);
    });
  });

  describe('installAgentSchedule (launchctl)', () => {
    it('calls launchctl load', async () => {
      await installAgentSchedule('agent-lc', '1h', 'prompt', 'launchctl');
      const loadCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'launchctl' && args[0] === 'load'
      );
      expect(loadCall).toBeTruthy();
    });

    it('writes plist file', async () => {
      await installAgentSchedule('agent-plist', '30m', 'prompt', 'launchctl');
      const laAgentsDir = join(tempDir, 'Library', 'LaunchAgents');
      const plistPath = join(laAgentsDir, 'com.test.agent.agent-plist.plist');
      expect(existsSync(plistPath)).toBe(true);
      const content = readFileSync(plistPath, 'utf-8');
      expect(content).toContain('<string>com.test.agent.agent-plist</string>');
      expect(content).toContain('<integer>1800</integer>'); // 30m = 1800s
    });
  });

  describe('uninstallAgentSchedule (launchctl)', () => {
    it('calls launchctl unload and removes plist', async () => {
      // First install
      await installAgentSchedule('agent-unload', '1h', 'prompt', 'launchctl');
      execMock.mockClear();
      const laAgentsDir = join(tempDir, 'Library', 'LaunchAgents');
      const plistPath = join(laAgentsDir, 'com.test.agent.agent-unload.plist');
      expect(existsSync(plistPath)).toBe(true);

      await uninstallAgentSchedule('agent-unload', 'launchctl');

      const unloadCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'launchctl' && args[0] === 'unload'
      );
      expect(unloadCall).toBeTruthy();
      expect(existsSync(plistPath)).toBe(false);
    });

    it('does not throw if plist does not exist', async () => {
      await expect(
        uninstallAgentSchedule('nonexistent-lc-agent', 'launchctl')
      ).resolves.not.toThrow();
    });
  });

  describe('isAgentScheduleLoaded (launchctl)', () => {
    it('returns true when launchctl list exits 0', async () => {
      execMock.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });
      const loaded = await isAgentScheduleLoaded('agent-lc', 'launchctl');
      expect(loaded).toBe(true);
    });

    it('returns false when launchctl list exits non-zero', async () => {
      execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Could not find service' });
      const loaded = await isAgentScheduleLoaded('agent-lc-missing', 'launchctl');
      expect(loaded).toBe(false);
    });
  });

  describe('defaults to pm2 runner', () => {
    it('installAgentSchedule defaults to pm2', async () => {
      await installAgentSchedule('agent-default', '1h', 'prompt');
      const pm2Start = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      expect(pm2Start).toBeTruthy();
    });

    it('uninstallAgentSchedule defaults to pm2', async () => {
      await uninstallAgentSchedule('agent-default');
      const pm2Delete = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete'
      );
      expect(pm2Delete).toBeTruthy();
    });
  });
});

describe('agent-scheduler — custom logDir from getImproveConfig', () => {
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let installAgentSchedule: typeof import('@/lib/agent-scheduler').installAgentSchedule;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-scheduler-custom-logdir-'));
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tempDir };
    });

    vi.doMock('@/lib/shell', () => ({ exec: execMock }));

    vi.doMock('@/lib/config', () => ({
      getSettings: vi.fn().mockReturnValue({ launchagent_prefix: 'com.test' }),
    }));

    // Override scheduling to return a custom logDir different from homedir/logs
    vi.doMock('@/lib/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        logDir: join(tempDir, 'custom-logs'),
        claudeBin: 'claude',
      }),
    }));

    const mod = await import('@/lib/agent-scheduler');
    installAgentSchedule = mod.installAgentSchedule;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes script to custom logDir from getImproveConfig', async () => {
    await installAgentSchedule('agent-custom', '1h', 'prompt', 'pm2');
    const scriptPath = join(tempDir, 'custom-logs', 'agent-scripts', 'agent-custom.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('writes prompt json to custom logDir from getImproveConfig', async () => {
    await installAgentSchedule('agent-custom-prompt', '30m', 'my task', 'pm2');
    const promptPath = join(tempDir, 'custom-logs', 'agent-scripts', 'agent-custom-prompt.prompt.json');
    expect(existsSync(promptPath)).toBe(true);
    const content = JSON.parse(readFileSync(promptPath, 'utf-8'));
    expect(content.prompt).toBe('my task');
  });
});
