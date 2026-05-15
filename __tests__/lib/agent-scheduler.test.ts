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
    dumpInternalSchedulerMock: vi.fn<() => { entries: Array<{ agentId: string; project: string; name: string; schedule: string; nextFireMs: number; lastFireMs: number }>; nowMs: number }>(() => ({ entries: [], nowMs: Date.now() })),
  };
});
const tempDir = mocks.tempDir;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mocks.tempDir };
});

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.execMock }));

vi.mock('@/lib/shared/config', () => ({
  getSettings: vi.fn().mockReturnValue({}),
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
  const dumpInternalSchedulerMock = mocks.dumpInternalSchedulerMock;

  beforeEach(() => {
    execMock.mockReset();
    execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    upsertAgentScheduleMock.mockReset();
    removeAgentScheduleMock.mockReset();
    dumpInternalSchedulerMock.mockReset().mockReturnValue({ entries: [], nowMs: Date.now() });
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

    // Legacy PM2-cleanup-on-install path was retired with the rest of the
    // per-job PM2 infrastructure. installAgentSchedule no longer issues any
    // pm2 commands — the internal scheduler is the only target.

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

    // Legacy PM2 cleanup on uninstall was retired — no pm2 commands issued.

    it('does not throw when nothing was previously installed', async () => {
      await expect(uninstallAgentSchedule('nonexistent-agent', 'pm2')).resolves.not.toThrow();
    });
  });

  describe('isAgentScheduleLoaded (via internal scheduler dump)', () => {
    it('returns true when the agent id is present in the internal scheduler', async () => {
      dumpInternalSchedulerMock.mockReturnValue({
        entries: [{ agentId: 'agent-running', project: 'p', name: 'n', schedule: '1h', nextFireMs: 0, lastFireMs: 0 }],
        nowMs: Date.now(),
      });
      const loaded = await isAgentScheduleLoaded('agent-running', 'pm2');
      expect(loaded).toBe(true);
    });

    it('returns false when the agent id is missing from the internal scheduler', async () => {
      dumpInternalSchedulerMock.mockReturnValue({ entries: [], nowMs: Date.now() });
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
