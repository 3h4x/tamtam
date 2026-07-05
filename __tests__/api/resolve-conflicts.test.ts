import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';

// Route-guard tests for POST /resolve-conflicts. The heavy git/agent behavior
// lives in the harness (finalizeResolveConflicts, covered separately); this
// suite pins the request contract + the safety guards the route enforces
// BEFORE spawning an agent that edits a PR branch.

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'rc-job-id',
    project: 'proj1',
    kind: 'resolve-conflicts',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  } as JobData;
}

const OPEN_CONFLICTING_PR = {
  number: 85,
  url: 'https://github.com/o/r/pull/85',
  state: 'OPEN',
  mergeable: 'CONFLICTING',
  branch: 'fix/issue-11',
  base: 'main',
  repo: 'o/r',
};

function reqWith(body: unknown, project = 'proj1') {
  return new NextRequest(`http://localhost/api/projects/by-project/${project}/resolve-conflicts`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/projects/by-project/[projectName]/resolve-conflicts', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ projectName: string }> }) => Promise<Response>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let gateMock: ReturnType<typeof vi.fn>;
  let getPrForResolveMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(4242);
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'codex' });
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    gateMock = vi.fn().mockReturnValue({ ok: true, reason: 'trusted_authors' });
    getPrForResolveMock = vi.fn().mockResolvedValue({ ...OPEN_CONFLICTING_PR });

    // Default git/gh: fetch ok, clean tree, already on the PR branch, diff ok.
    execMock = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(' ');
      if (key.includes('status --porcelain')) return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      if (key.includes('branch --show-current')) return Promise.resolve({ exitCode: 0, stdout: 'fix/issue-11\n', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({ logDir: '/tmp/tamtam-logs' }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock, updateJob: updateJobMock, listJobs: listJobsMock, probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({ startJobInProcess: startJobMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: vi.fn().mockReturnValue(''), getSettings: vi.fn().mockReturnValue({}),
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: vi.fn().mockReturnValue('claude'),
      resolveCliEnv: vi.fn().mockReturnValue({}),
      resolveCliDefaultModel: vi.fn().mockReturnValue('sonnet'),
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({ checkCliStartGate: checkCliStartGateMock }));
    vi.doMock('@/lib/usage/cli-providers', () => ({ isCliProvider: () => false }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({ findBlockingRunningJob: findBlockingRunningJobMock }));
    vi.doMock('@/lib/security/pr-branch-execution', () => ({ checkPrBranchExecutionGate: gateMock }));
    vi.doMock('@/lib/jobs/resolve-conflicts', () => ({
      getPrForResolve: getPrForResolveMock,
      composeResolveConflictsPrompt: vi.fn().mockReturnValue('PROMPT'),
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/resolve-conflicts/route');
    POST = mod.POST;
  });

  afterEach(() => vi.resetModules());

  it('returns 400 when prNumber is missing/invalid', async () => {
    const res = await POST(reqWith({}), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the PR cannot be resolved', async () => {
    getPrForResolveMock.mockResolvedValue(null);
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(404);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the PR is not open', async () => {
    getPrForResolveMock.mockResolvedValue({ ...OPEN_CONFLICTING_PR, state: 'MERGED' });
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the PR is already mergeable (nothing to resolve)', async () => {
    getPrForResolveMock.mockResolvedValue({ ...OPEN_CONFLICTING_PR, mergeable: 'MERGEABLE' });
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the working tree is dirty', async () => {
    execMock.mockImplementation((cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(' ');
      if (key.includes('status --porcelain')) return Promise.resolve({ exitCode: 0, stdout: ' M foo.ts\n', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    // A dirty tree is not the whole story, so the refusal points at the manual
    // merge path rather than dead-ending on "commit/stash".
    expect((await res.json()).detail).toMatch(/merge it manually/i);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the PR-branch author-trust gate refuses', async () => {
    gateMock.mockReturnValue({ ok: false, detail: 'commit abc could not be mapped to a GitHub author' });
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    // The permanent author-trust blocker must offer both remedies (trust or
    // manual merge), keeping the resolve-conflicts HITL actionable.
    expect((await res.json()).detail).toMatch(/merge it manually/i);
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 when another job is already running for the project', async () => {
    findBlockingRunningJobMock.mockResolvedValue(makeJob({ id: 'run-1', kind: 'run' }));
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.blocking_job_id).toBe('run-1');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('spawns a resolve-conflicts job on the happy path', async () => {
    const res = await POST(reqWith({ prNumber: 85 }), { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('started');
    expect(createJobMock).toHaveBeenCalledWith(
      'proj1', 'resolve-conflicts', 0, '', undefined,
      expect.stringContaining('"prNumber":85'),
    );
    // contextMeta carries what finalize needs to verify + push + hand off.
    const metaArg = createJobMock.mock.calls[0][5] as string;
    expect(JSON.parse(metaArg)).toMatchObject({ prNumber: 85, branch: 'fix/issue-11', defaultBranch: 'main', prRepo: 'o/r' });
    expect(startJobMock).toHaveBeenCalled();
    // author-trust gate must be consulted before spawning.
    expect(gateMock).toHaveBeenCalled();
  });
});
