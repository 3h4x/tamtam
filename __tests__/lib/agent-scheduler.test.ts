import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Shared tempDir captured at hoist time — homedir() is captured by
// agent-scheduler.ts's `getLogDir()` fallback path when no DB-backed
// log-dir setting is available (the case under unit tests).
const mocks = vi.hoisted(() => {
  const fsMod = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const osMod = require('os') as typeof import('os');
  const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tamtam-scheduler-test-'));
  return {
    tempDir,
    quickAddJobMock: vi.fn(async () => undefined),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mocks.tempDir };
});

vi.mock('graphile-worker', () => ({
  quickAddJob: mocks.quickAddJobMock,
}));

// getImproveConfig reads DB-backed settings; in unit tests with no DB it
// throws — agent-scheduler.ts already catches that and falls back to
// `homedir()/logs`. The mock keeps the throw path deterministic.
vi.mock('@/lib/scheduling/scheduling', () => ({
  getImproveConfig: vi.fn(() => {
    throw new Error('no db in unit tests — fall back to homedir');
  }),
}));

import {
  installAgentSchedule,
  uninstallAgentSchedule,
  isAgentScheduleLoaded,
} from '@/lib/scheduling/agent-scheduler';

describe('agent-scheduler (graphile-worker backed)', () => {
  const tempDir = mocks.tempDir;
  const quickAddJobMock = mocks.quickAddJobMock;
  const scriptsDir = join(tempDir, 'logs', 'agent-scripts');

  beforeEach(() => {
    quickAddJobMock.mockReset();
    quickAddJobMock.mockResolvedValue(undefined);
    process.env.DATABASE_URL = 'postgres://test/test';
    delete process.env.WORKFLOW_POSTGRES_URL;
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('installAgentSchedule', () => {
    it('persists the prompt to disk and enqueues an agent-cron job', async () => {
      await installAgentSchedule('agent-abc', '30m', 'run tests', 'projA', 'My Agent');

      // Prompt file is written so out-of-band reruns can recover the prompt.
      const promptPath = join(scriptsDir, 'agent-abc.prompt.json');
      expect(existsSync(promptPath)).toBe(true);
      expect(JSON.parse(readFileSync(promptPath, 'utf8'))).toEqual({ prompt: 'run tests' });

      expect(quickAddJobMock).toHaveBeenCalledOnce();
      const call = quickAddJobMock.mock.calls[0] as unknown as [
        { connectionString: string },
        string,
        { agentId: string },
        { jobKey: string; jobKeyMode: string; runAt: Date; maxAttempts: number },
      ];
      expect(call[0]).toEqual({ connectionString: 'postgres://test/test' });
      expect(call[1]).toBe('agent-cron');
      expect(call[2]).toEqual({ agentId: 'agent-abc' });
      expect(call[3]).toMatchObject({
        jobKey: 'agent-cron-agent-abc',
        jobKeyMode: 'replace',
        maxAttempts: 5,
      });
      expect(call[3].runAt).toBeInstanceOf(Date);
    });

    it('throws when no postgres URL is configured', async () => {
      delete process.env.DATABASE_URL;
      delete process.env.WORKFLOW_POSTGRES_URL;
      await expect(installAgentSchedule('agent-no-pg', '1h', 'p')).rejects.toThrow(/no postgres URL/);
    });

    it('enqueues into WORKFLOW_POSTGRES_URL when workflow and app databases differ', async () => {
      process.env.WORKFLOW_POSTGRES_URL = 'postgres://workflow/test';

      await installAgentSchedule('agent-workflow-db', '30m', 'run tests', 'projA', 'My Agent');

      expect(quickAddJobMock).toHaveBeenCalledOnce();
      const call = quickAddJobMock.mock.calls[0] as unknown as [
        { connectionString: string },
        string,
        { agentId: string },
      ];
      expect(call[0]).toEqual({ connectionString: 'postgres://workflow/test' });
      expect(call[1]).toBe('agent-cron');
      expect(call[2]).toEqual({ agentId: 'agent-workflow-db' });
    });
  });

  describe('uninstallAgentSchedule', () => {
    it('replaces the agent-cron job with a one-year-out runAt and removes the prompt file', async () => {
      // First install to create the prompt file...
      await installAgentSchedule('agent-to-remove', '1h', 'p', 'proj', 'agt');
      const promptPath = join(scriptsDir, 'agent-to-remove.prompt.json');
      expect(existsSync(promptPath)).toBe(true);
      quickAddJobMock.mockClear();

      await uninstallAgentSchedule('agent-to-remove', 'proj', 'agt');

      expect(quickAddJobMock).toHaveBeenCalledOnce();
      const call = quickAddJobMock.mock.calls[0] as unknown as [
        { connectionString: string },
        string,
        { agentId: string },
        { runAt: Date },
      ];
      expect(call[2]).toEqual({ agentId: 'agent-to-remove' });
      // Far-future runAt (≥ ~1 year) so the chain naturally winds down once
      // the cron task handler notices the agent row is disabled / gone.
      expect(call[3].runAt.getTime() - Date.now()).toBeGreaterThan(360 * 24 * 60 * 60 * 1000);
      // Prompt file is cleaned up.
      expect(existsSync(promptPath)).toBe(false);
    });

    it('does not throw when uninstalling an agent that was never installed', async () => {
      await expect(uninstallAgentSchedule('nonexistent-agent')).resolves.not.toThrow();
    });

    it('cancels in WORKFLOW_POSTGRES_URL when workflow and app databases differ', async () => {
      process.env.WORKFLOW_POSTGRES_URL = 'postgres://workflow/test';

      await uninstallAgentSchedule('agent-workflow-db', 'proj', 'agt');

      expect(quickAddJobMock).toHaveBeenCalledOnce();
      const call = quickAddJobMock.mock.calls[0] as unknown as [
        { connectionString: string },
        string,
        { agentId: string },
      ];
      expect(call[0]).toEqual({ connectionString: 'postgres://workflow/test' });
      expect(call[1]).toBe('agent-cron');
      expect(call[2]).toEqual({ agentId: 'agent-workflow-db' });
    });
  });

  describe('isAgentScheduleLoaded', () => {
    it('returns true when the per-agent prompt file exists', async () => {
      await installAgentSchedule('agent-loaded', '1h', 'p');
      expect(await isAgentScheduleLoaded('agent-loaded')).toBe(true);
    });

    it('returns false when no prompt file exists for the agent', async () => {
      expect(await isAgentScheduleLoaded('agent-missing-' + Date.now())).toBe(false);
    });
  });
});
