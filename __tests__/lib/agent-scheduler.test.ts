import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('agent-scheduler', () => {
  let tempDir: string;
  let execMock: ReturnType<typeof vi.fn>;
  let upsertAgentScheduleMock: ReturnType<typeof vi.fn>;
  let removeAgentScheduleMock: ReturnType<typeof vi.fn>;
  let installAgentSchedule: typeof import('@/lib/scheduling/agent-scheduler').installAgentSchedule;
  let uninstallAgentSchedule: typeof import('@/lib/scheduling/agent-scheduler').uninstallAgentSchedule;
  let isAgentScheduleLoaded: typeof import('@/lib/scheduling/agent-scheduler').isAgentScheduleLoaded;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-scheduler-test-'));
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    upsertAgentScheduleMock = vi.fn();
    removeAgentScheduleMock = vi.fn();

    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tempDir };
    });

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: vi.fn().mockReturnValue({ launchagent_prefix: 'com.test' }),
    }));
    vi.doMock('@/lib/scheduling/internal-scheduler', () => ({
      upsertAgentSchedule: upsertAgentScheduleMock,
      removeAgentSchedule: removeAgentScheduleMock,
    }));

    const mod = await import('@/lib/scheduling/agent-scheduler');
    installAgentSchedule = mod.installAgentSchedule;
    uninstallAgentSchedule = mod.uninstallAgentSchedule;
    isAgentScheduleLoaded = mod.isAgentScheduleLoaded;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('installAgentSchedule (pm2 runner → internal scheduler)', () => {
    it('registers the agent with the internal scheduler', async () => {
      await installAgentSchedule('agent-abc', '30m', 'run tests', 'pm2', 'projA', 'My Agent');
      expect(upsertAgentScheduleMock).toHaveBeenCalledOnce();
      expect(upsertAgentScheduleMock).toHaveBeenCalledWith({
        id: 'agent-abc',
        project: 'projA',
        name: 'My Agent',
        schedule: '30m',
        prompt: 'run tests',
        enabled: true,
      });
    });

    it('also sweeps any legacy PM2 cron entry as a one-time cleanup', async () => {
      await installAgentSchedule('agent-abc', '1h', 'p', 'pm2', 'projA', 'My Agent');
      const pm2Delete = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete'
      );
      expect(pm2Delete).toBeTruthy();
      expect(pm2Delete![1]).toContain('tamtam-projA-agent-My Agent');
    });

    it('does NOT register a PM2 cron entry (the broken legacy path)', async () => {
      await installAgentSchedule('agent-abc', '1h', 'p', 'pm2');
      const pm2Start = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'start'
      );
      expect(pm2Start).toBeFalsy();
    });

    it('falls back to agent-id for name when project/agentName missing', async () => {
      await installAgentSchedule('agent-xyz', '1h', 'p', 'pm2');
      expect(upsertAgentScheduleMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-xyz', name: 'agent-xyz', project: '' })
      );
    });
  });

  describe('uninstallAgentSchedule (pm2 runner → internal scheduler)', () => {
    it('removes the agent from the internal scheduler', async () => {
      await uninstallAgentSchedule('agent-to-remove', 'pm2', 'projA', 'My Agent');
      expect(removeAgentScheduleMock).toHaveBeenCalledOnce();
      expect(removeAgentScheduleMock).toHaveBeenCalledWith('agent-to-remove');
    });

    it('also issues a pm2 delete for legacy cleanup', async () => {
      await uninstallAgentSchedule('agent-to-remove', 'pm2', 'projA', 'My Agent');
      const pm2Delete = execMock.mock.calls.find(
        ([cmd, args]: any) => cmd === 'pm2' && args[0] === 'delete'
      );
      expect(pm2Delete).toBeTruthy();
    });

    it('does not throw when nothing was previously installed', async () => {
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

    it('writes day-based schedules as day-length intervals, not raw seconds', async () => {
      await installAgentSchedule('agent-days', '3d', 'prompt', 'launchctl');
      const laAgentsDir = join(tempDir, 'Library', 'LaunchAgents');
      const plistPath = join(laAgentsDir, 'com.test.agent.agent-days.plist');
      expect(existsSync(plistPath)).toBe(true);
      const content = readFileSync(plistPath, 'utf-8');
      expect(content).toContain('<integer>259200</integer>'); // 3d = 259200s
      expect(content).not.toContain('<integer>3</integer>');
    });

    it('does not touch the internal scheduler for launchctl runner', async () => {
      await installAgentSchedule('agent-lc', '1h', 'prompt', 'launchctl');
      expect(upsertAgentScheduleMock).not.toHaveBeenCalled();
    });
  });

  describe('uninstallAgentSchedule (launchctl)', () => {
    it('calls launchctl unload and removes plist', async () => {
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
    it('installAgentSchedule defaults to pm2 (internal scheduler)', async () => {
      await installAgentSchedule('agent-default', '1h', 'prompt');
      expect(upsertAgentScheduleMock).toHaveBeenCalledOnce();
    });

    it('uninstallAgentSchedule defaults to pm2 (internal scheduler)', async () => {
      await uninstallAgentSchedule('agent-default');
      expect(removeAgentScheduleMock).toHaveBeenCalledOnce();
    });
  });
});
