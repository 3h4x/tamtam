import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Tests for the Direct Branch + fix/issue-* branch guard in the agent run route.

describe('POST /api/agents/[agentId]/run — Direct Branch issue-branch guard', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;
  let execMock: ReturnType<typeof vi.fn>;
  let getProjectTestConfigMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  const dbAgent = {
    id: 'agent-1',
    name: 'my-agent',
    project: 'proj',
    skillIds: '[]',
    model: 'sonnet',
    prompt: 'do something',
    schedule: null,
    runner: 'pm2',
    enabled: true,
  };

  beforeEach(async () => {
    vi.resetModules();

    execMock = vi.fn();
    getProjectTestConfigMock = vi.fn();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    startJobMock = vi.fn().mockResolvedValue(1234);
    createJobMock = vi.fn().mockReturnValue({ id: 'job-1', project: 'proj', kind: 'agent:my-agent', pid: 0, logPath: '' });
    updateJobMock = vi.fn();

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/test-logs', claudeBin: 'claude', projects: {} }),
      getProjectTestConfig: getProjectTestConfigMock,
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({ startJob: startJobMock }));
    vi.doMock('@/lib/shared/config', () => ({
      withBasePrompt: (p: string) => p,
      getPermissionModeFlag: () => '--permission-mode default',
    }));
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: '/tmp/skills',
      DATA_SKILLS_DIR: '/tmp/data-skills',
    }));
    vi.doMock('@/lib/agents/tamtam-file-agents', () => ({
      parseFileAgentId: () => null,
      loadFileAgent: () => null,
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: () => ({ from: () => ({ where: () => ({ get: () => dbAgent } as any) }) }),
      },
      schema: { agents: {}, skills: {} },
    }));

    const mod = await import('@/app/api/agents/[agentId]/run/route');
    POST = mod.POST;
  });

  function makeRequest(body: Record<string, unknown> = { prompt: 'hello' }) {
    return new NextRequest('http://localhost/api/agents/agent-1/run', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('refuses agent run in Direct Branch mode when on a fix/issue-* branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false });
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'fix/issue-45-my-bug\n', stderr: '' });

    const res = await POST(makeRequest(), { params: Promise.resolve({ agentId: 'agent-1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.detail).toContain('Direct Branch mode');
    expect(body.detail).toContain('fix/issue-45-my-bug');
    expect(body.branch).toBe('fix/issue-45-my-bug');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('allows agent run in Direct Branch mode when on the default branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: false });
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'master\n', stderr: '' });

    const res = await POST(makeRequest(), { params: Promise.resolve({ agentId: 'agent-1' }) });

    // Should not be blocked by the issue-branch guard (may succeed or fail for other reasons)
    expect(res.status).not.toBe(409);
  });

  it('allows agent run in PR Workflow mode even when on a fix/issue-* branch', async () => {
    getProjectTestConfigMock.mockReturnValue({ prWorkflowEnabled: true });
    // exec should NOT be called for branch check in PR Workflow mode
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'fix/issue-45-my-bug\n', stderr: '' });

    const res = await POST(makeRequest(), { params: Promise.resolve({ agentId: 'agent-1' }) });

    // In PR Workflow mode the guard is skipped; agent may start
    expect(res.status).not.toBe(409);
  });

  it('allows agent run when project config is null (no project row)', async () => {
    getProjectTestConfigMock.mockReturnValue(null);
    execMock.mockResolvedValue({ exitCode: 0, stdout: 'fix/issue-99-something\n', stderr: '' });

    const res = await POST(makeRequest(), { params: Promise.resolve({ agentId: 'agent-1' }) });

    // No config → guard is skipped
    expect(res.status).not.toBe(409);
  });
});
