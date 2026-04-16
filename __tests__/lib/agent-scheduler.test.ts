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

    it('uses auth header in script when Z_API_TOKEN is set', async () => {
      process.env.Z_API_TOKEN = 'test-token-123';
      await installAgentSchedule('agent-auth', '1h', 'prompt', 'pm2');
      const scriptPath = join(tempDir, 'logs', 'agent-scripts', 'agent-auth.sh');
      const script = readFileSync(scriptPath, 'utf-8');
      expect(script).toContain('Authorization: Bearer test-token-123');
      delete process.env.Z_API_TOKEN;
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

    it('converts hours to cron expression', async () => {
      await installAgentSchedule('agent-hourly', '2h', 'prompt', 'pm2');
      const startCall = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      const args: string[] = startCall![1];
      const cronIdx = args.indexOf('--cron');
      expect(args[cronIdx + 1]).toBe('0 */2 * * *');
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
