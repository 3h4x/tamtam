import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Single shared tempDir for the entire suite. agent-scheduler.ts captures
// `LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')` at module
// load, so homedir() must be stable across tests. Created inside the hoisted
// block so it exists before vi.mock factories run on first SUT import.
const mocks = vi.hoisted(() => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const osMod = require('os') as typeof import('os');
  const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tamtam-scheduler-test-'));
  return {
    tempDir,
    execMock: vi.fn(),
    upsertAgentScheduleMock: vi.fn(),
    removeAgentScheduleMock: vi.fn(),
    dumpInternalSchedulerMock: vi.fn(() => ({ entries: [] })),
  };
});
const tempDir = mocks.tempDir;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mocks.tempDir };
});

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn().mockReturnValue({ launchagent_prefix: 'com.test' }),
}));

vi.mock('@/lib/scheduling/internal-scheduler', () => ({
  upsertAgentSchedule: mocks.upsertAgentScheduleMock,
  removeAgentSchedule: mocks.removeAgentScheduleMock,
  dumpInternalScheduler: mocks.dumpInternalSchedulerMock,
}));

import {
  installAgentSchedule,
  uninstallAgentSchedule,
  isAgentScheduleLoaded,
} from '@/lib/scheduling/agent-scheduler';

describe('agent-scheduler', () => {
  const execMock = mocks.execMock;
  const upsertAgentScheduleMock = mocks.upsertAgentScheduleMock;
  const removeAgentScheduleMock = mocks.removeAgentScheduleMock;

  beforeEach(() => {
    execMock.mockReset();
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    upsertAgentScheduleMock.mockReset();
    removeAgentScheduleMock.mockReset();
  });

  afterAll(() => {
    (require('fs') as typeof import('fs')).rmSync(tempDir, { recursive: true, force: true });
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
