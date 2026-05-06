import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('recovery-drain', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not replay queued agents while a release is still pending', async () => {
    const drainPendingRelease = vi.fn().mockResolvedValue(undefined);
    const getPendingRelease = vi.fn().mockReturnValue(true);
    const getLock = vi.fn().mockReturnValue(null);
    const drainQueuedAgentRunsForProject = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/pipeline/pending-release', () => ({
      drainPendingRelease,
      getPendingRelease,
      listPendingReleaseProjects: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock,
    }));
    vi.doMock('@/lib/agents/queued-agent-runs', () => ({
      drainQueuedAgentRunsForProject,
      listQueuedAgentRunProjects: vi.fn().mockReturnValue([]),
    }));

    const { drainProjectRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainProjectRecoveryWork('proj');

    expect(drainPendingRelease).toHaveBeenCalledWith('proj');
    expect(drainQueuedAgentRunsForProject).not.toHaveBeenCalled();
    expect(getLock).not.toHaveBeenCalled();
  });

  it('drains the pending release before replaying queued agents for the same project', async () => {
    let pending = true;
    const order: string[] = [];
    const drainPendingRelease = vi.fn().mockImplementation(async () => {
      order.push('pending');
      pending = false;
    });
    const getPendingRelease = vi.fn().mockImplementation(() => pending);
    const getLock = vi.fn().mockImplementation(() => {
      order.push('lock');
      return null;
    });
    const drainQueuedAgentRunsForProject = vi.fn().mockImplementation(async () => {
      order.push('agent');
    });

    vi.doMock('@/lib/pipeline/pending-release', () => ({
      drainPendingRelease,
      getPendingRelease,
      listPendingReleaseProjects: vi.fn().mockReturnValue([]),
    }));
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      getLock,
    }));
    vi.doMock('@/lib/agents/queued-agent-runs', () => ({
      drainQueuedAgentRunsForProject,
      listQueuedAgentRunProjects: vi.fn().mockReturnValue([]),
    }));

    const { drainProjectRecoveryWork } = await import('@/lib/pipeline/recovery-drain');
    await drainProjectRecoveryWork('proj');

    expect(order).toEqual(['pending', 'lock', 'agent']);
    expect(drainQueuedAgentRunsForProject).toHaveBeenCalledWith('proj');
  });
});
