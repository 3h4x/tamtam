import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

const CI_URL = 'https://github.com/owner/repo/actions/runs/12345';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'fix-ci-job-id',
    project: 'proj1',
    kind: 'fix-ci',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/projects/by-project/[projectName]/fix-ci', () => {
  let POST: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let execMock: ReturnType<typeof vi.fn>;
  let dbGetMock: ReturnType<typeof vi.fn<() => unknown>>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let getPermissionModeFlagMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/project');
    listJobsMock = vi.fn().mockReturnValue([]);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    createJobMock = vi.fn().mockImplementation(() => makeJob());
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(42);
    execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Build failed\nError: test suite failed', stderr: '' });
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'codex' });
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    getPermissionModeFlagMock = vi.fn().mockImplementation((mode?: string | null) =>
      mode ? `--permission-mode ${mode}` : '');
    getSettingsMock = vi.fn().mockReturnValue({ default_model: 'sonnet', fix_ci_bypass_sandbox: true });

    dbGetMock = vi.fn().mockReturnValue({ project: 'proj1', ciFailedUrl: CI_URL });
    const limitThenable = () => {
      const value = dbGetMock();
      return Promise.resolve(value ? [value] : []);
    };

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
        projects: {},
      }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      probeJobStatus: probeJobStatusMock,
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({ startJobInProcess: startJobMock }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/shared/config', () => ({ getPermissionModeFlag: getPermissionModeFlagMock, getSettings: getSettingsMock }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: findBlockingRunningJobMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => limitThenable()),
            }),
          }),
        }),
      },
      schema: { ghStatus: { project: 'project' } },
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/fix-ci/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 404 when project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toBe('project not found');
  });

  it('returns 409 when fix-ci already running', async () => {
    const runningJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([runningJob]);
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.detail).toContain('already in progress');
  });

  it('returns 400 when no failed CI URL exists', async () => {
    dbGetMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No failed CI URL');
  });

  it('returns 409 with blocking_job_id when another project job is already running', async () => {
    findBlockingRunningJobMock.mockResolvedValue(makeJob({ id: 'run-123', kind: 'run' }));

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain("Job 'run' is already running");
    expect(data.blocking_job_id).toBe('run-123');
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 when no failed CI URL (no ciFailedUrl field)', async () => {
    dbGetMock.mockReturnValue({ project: 'proj1', ciFailedUrl: null });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 502 when gh run view fails to fetch logs', async () => {
    // gh failure (rate-limit, auth, run gone) is an upstream failure — the
    // route returns 502 instead of asking Claude to "fix" gh's stderr text.
    execMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.detail).toContain('gh run view failed');
  });

  it('returns the global pause conflict when jobs are paused', async () => {
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to start a CI fix.',
    });

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('Jobs are paused globally');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('starts fix-ci job and returns job info', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.ci_url).toBe(CI_URL);
  });

  it('launches the CI fix in bypassPermissions mode when fix_ci_bypass_sandbox is on (default)', async () => {
    // fix-ci must reproduce the CI failure locally: install deps, build, run
    // tests. Under the default `auto` mode the Codex sandbox (workspace-write)
    // blocks outbound network, so `pnpm install` fails with ENOTFOUND and the
    // fix can never be verified. bypassPermissions is the only mode that grants
    // the network access this job fundamentally needs.
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    expect(getPermissionModeFlagMock).toHaveBeenCalledWith('bypassPermissions');
    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--permission-mode bypassPermissions');
  });

  it('keeps the global permission mode when fix_ci_bypass_sandbox is off', async () => {
    getSettingsMock.mockReturnValue({ default_model: 'sonnet', fix_ci_bypass_sandbox: false });
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    // No forced override — fall back to the global permission_mode.
    expect(getPermissionModeFlagMock).toHaveBeenCalledWith(undefined);
    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).not.toContain('bypassPermissions');
  });

  it('passes the preferred provider header into the chooser', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', {
      method: 'POST',
      headers: { 'x-tamtam-provider-preferred': 'claude' },
    });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(checkCliStartGateMock).toHaveBeenCalledWith('start a CI fix', { preferred: 'claude' });
  });

  it('calls gh with the run ID extracted from the CI URL', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    const ghCall = execMock.mock.calls.find((c: any[]) => c[0] === 'gh');
    expect(ghCall).toBeDefined();
    expect(ghCall![1]).toContain('12345');
    expect(ghCall![1]).toContain('owner/repo');
    expect(ghCall![1]).toContain('--log-failed');
  });

  it('skips running jobs that are not actually running', async () => {
    const staleJob = makeJob({ finishedAt: null });
    listJobsMock.mockReturnValue([staleJob]);
    probeJobStatusMock.mockResolvedValue('done');

    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
  });

  it('persists job failure when startJob throws', async () => {
    startJobMock.mockRejectedValue(new Error('spawn unavailable'));
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('spawn unavailable');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });
});

describe('POST /api/projects/by-project/[projectName]/fix-ci weekly model scoring', () => {
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');

    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 20, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 30, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 50, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    startJobMock = vi.fn().mockResolvedValue(42);

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/project'),
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
        projects: {},
      }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: vi.fn().mockImplementation(() => makeJob()),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      probeJobStatus: vi.fn().mockResolvedValue('done'),
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({ startJobInProcess: startJobMock }));
    vi.doMock('@/lib/shared/shell', () => ({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Build failed\nError: test suite failed', stderr: '' }),
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: vi.fn().mockReturnValue(''),
      getSettings: vi.fn().mockReturnValue({
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
        default_model: 'normal',
        cli_bin_claude: '',
        cli_bin_codex: '',
        cli_bin_gemini: '',
        cli_bin_lmstudio: '',
      }),
    }));
    vi.doMock('@/lib/shared/job-control', () => ({
      jobsPausedResult: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('@/lib/usage/quota', () => ({
      getQuotaSnapshots: vi.fn().mockResolvedValue(snapshots),
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ project: 'proj1', ciFailedUrl: CI_URL }]),
            }),
          }),
        }),
      },
      schema: { ghStatus: { project: 'project' } },
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/fix-ci/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('ignores an unrelated Claude weekly sub-window when the root path has not picked a tier yet', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/fix-ci', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ projectName: 'proj1' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, cmd] = startJobMock.mock.calls[0];
    expect(cmd).toContain('/scripts/claude-shim.js');
  });
});
