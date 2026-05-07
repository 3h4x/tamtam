import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { JobData } from '@/lib/jobs/job-storage';
import type { CliProvider } from '@/lib/usage/cli-providers';
import type { QuotaSnapshot } from '@/lib/usage/quota-types';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job-source',
    project: 'proj1',
    kind: 'run',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/jobs/{jobId}/rerun', () => {
  let POST: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    getJobMock = vi.fn().mockReturnValue(null);
    createJobMock = vi.fn().mockImplementation(() =>
      makeJob({ id: 'job-new', finishedAt: null, exitCode: null })
    );
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(9999);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'codex' });
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'started', job_id: 'delegated-job' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    getSettingsMock = vi.fn(() => ({
      default_model: 'fast',
      cli_default_model_codex: 'smart',
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
      }),
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));

    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: getSettingsMock,
    }));

    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: findBlockingRunningJobMock,
    }));

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));

    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('@/app/api/jobs/[jobId]/rerun/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns 404 when source job does not exist', async () => {
    getJobMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 404 when project path cannot be resolved', async () => {
    getJobMock.mockReturnValue(makeJob({ project: 'missing-proj' }));
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('missing-proj');
  });

  it('starts a new job and returns status=started', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
  });

  it('calls startJob once', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(startJobMock).toHaveBeenCalledOnce();
  });

  it('uses the selected provider default model when rerunning', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    const [, command] = startJobMock.mock.calls[0];
    expect(command).toContain('--model smart');
  });

  it('passes the source job provider as a soft preference to the chooser', async () => {
    getJobMock.mockReturnValue(makeJob({ provider: 'claude' }));
    checkCliStartGateMock.mockResolvedValue({ ok: true, provider: 'codex' });

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(checkCliStartGateMock).toHaveBeenCalledWith('rerun a job', { preferred: 'claude' });
    const [, command] = startJobMock.mock.calls[0];
    expect(command).toContain('/scripts/codex-shim.js');
  });

  it('returns the global pause conflict for non-delegated reruns when jobs are paused', async () => {
    getJobMock.mockReturnValue(makeJob({ provider: 'claude' }));
    checkCliStartGateMock.mockResolvedValue({
      ok: false,
      status: 409,
      detail: 'Jobs are paused globally. Turn the switch back on in Settings to rerun a job.',
    });

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain('Jobs are paused globally');
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('returns 409 with blocking_job_id when another project job is already running', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'fix' }));
    findBlockingRunningJobMock.mockResolvedValue(makeJob({
      id: 'run-123',
      kind: 'run',
      finishedAt: null,
      exitCode: null,
    }));

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain("Job 'run' is already running");
    expect(data.blocking_job_id).toBe('run-123');
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the source provider to delegated review reruns without re-gating locally', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'review', provider: 'claude' }));

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
      headers: { 'x-test': '1' },
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(res.status).toBe(200);
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/projects/by-project/proj1/review');
    const headers = init?.headers as Headers;
    expect(headers.get('x-tamtam-provider-preferred')).toBe('claude');
    expect(headers.get('x-test')).toBe('1');
  });

  it('forwards the source provider to delegated fix-ci reruns without re-gating locally', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'fix-ci', provider: 'codex' }));

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(res.status).toBe(200);
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(headers.get('x-tamtam-provider-preferred')).toBe('codex');
  });

  it('passes through busy conflicts from delegated fix-ci reruns', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'fix-ci', provider: 'codex' }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        detail: "Job 'run' is already running for proj1 (job run-123)",
        blocking_job_id: 'run-123',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.detail).toContain("Job 'run' is already running");
    expect(data.blocking_job_id).toBe('run-123');
    expect(checkCliStartGateMock).not.toHaveBeenCalled();
    expect(startJobMock).not.toHaveBeenCalled();
  });

  it('calls updateJob after startJob', async () => {
    getJobMock.mockReturnValue(makeJob());
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(updateJobMock).toHaveBeenCalledOnce();
  });

  it('returns 500 when startJob throws', async () => {
    getJobMock.mockReturnValue(makeJob());
    startJobMock.mockRejectedValue(new Error('pm2 failed'));
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.detail).toContain('pm2 failed');
    // Job must be persisted as failed so it doesn't stay "running" in the DB
    expect(updateJobMock).toHaveBeenCalledOnce();
    const savedJob = updateJobMock.mock.calls[0][0];
    expect(savedJob.exitCode).toBe(-1);
    expect(savedJob.finishedAt).not.toBeNull();
  });

});

describe('POST /api/jobs/{jobId}/rerun weekly quota gating', () => {
  let POST: any;
  let startJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');

    const snapshots = new Map<CliProvider, QuotaSnapshot | null>([
      ['claude', {
        provider: 'claude',
        fiveHour: { utilization: 24, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 99, resetsAt: null, msUntilReset: null },
        sevenDaySonnet: { utilization: 100, resetsAt: null, msUntilReset: null },
        sevenDayOpus: null,
        fetchedAt: 0,
        stale: false,
      }],
      ['codex', {
        provider: 'codex',
        fiveHour: { utilization: 97, resetsAt: null, msUntilReset: null },
        sevenDay: { utilization: 10, resetsAt: null, msUntilReset: null },
        fetchedAt: 0,
        stale: false,
      }],
    ]);

    startJobMock = vi.fn().mockResolvedValue(9999);
    updateJobMock = vi.fn();

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: vi.fn().mockReturnValue(makeJob({ provider: 'claude' })),
      createJob: vi.fn().mockImplementation(() =>
        makeJob({ id: 'job-new', finishedAt: null, exitCode: null })
      ),
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: '/tmp/tamtam-logs',
      }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/jobs/pm2-jobs', () => ({
      startJob: startJobMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: vi.fn(() => ({
        default_model: 'fast',
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
        cli_default_model_claude: 'normal',
        cli_bin_claude: '',
        cli_bin_codex: '',
        cli_bin_gemini: '',
        cli_bin_lmstudio: '',
      })),
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

    const mod = await import('@/app/api/jobs/[jobId]/rerun/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not 429 a rerun when only the preferred provider weekly quota is hot', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-source/rerun', {
      method: 'POST',
    });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, command] = startJobMock.mock.calls[0];
    expect(command).toContain('/scripts/claude-shim.js');
  });
});
