import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
    logPath: '/path/to/log',
    startedAt: 1000,
    finishedAt: 2000,
    exitCode: 0,
    seen: false,
    ...overrides,
  };
}

describe('POST /api/jobs/[jobId]/fix', () => {
  let POST: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let probeJobStatusMock: ReturnType<typeof vi.fn>;
  let readParsedLogMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let listJobsMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-fix-test-'));

    getJobMock = vi.fn().mockReturnValue(null);
    probeJobStatusMock = vi.fn().mockResolvedValue('done');
    readParsedLogMock = vi.fn().mockReturnValue('Error: something failed\nline 2');
    createJobMock = vi.fn().mockImplementation(() =>
      makeJob({ id: 'fix-job-1', kind: 'fix', pid: 0, logPath: null, finishedAt: null, exitCode: null })
    );
    updateJobMock = vi.fn();
    listJobsMock = vi.fn().mockReturnValue([]);
    startJobMock = vi.fn().mockResolvedValue(99999);
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    getSettingsMock = vi.fn(() => ({
      default_model: 'fast',
      cli_bin_claude: '',
      cli_bin_codex: '',
      cli_bin_gemini: '',
      cli_bin_lmstudio: '',
    }));

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      probeJobStatus: probeJobStatusMock,
      readParsedLog: readParsedLogMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
      listJobs: listJobsMock,
      markDone: vi.fn(),
    }));

    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: join(tempDir, 'logs'),
      }),
    }));

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobMock,
    }));

    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getPipelineModel: () => 'fast',
      getSettings: getSettingsMock,
    }));

    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));

    vi.doMock('@/lib/shared/job-control', () => ({
      runGates: () => null,
      jobsPausedResult: () => null,
      runAutoChainGates: () => null,
      isJobsPaused: () => false,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/fix/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 for nonexistent job', async () => {
    getJobMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/jobs/nonexistent/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'nonexistent' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('nonexistent');
  });

  it('returns 400 if job is still running', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: null, exitCode: null }));
    probeJobStatusMock.mockResolvedValue('running');

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('still running');
  });

  it('returns 400 if log output is empty', async () => {
    getJobMock.mockReturnValue(makeJob());
    readParsedLogMock.mockReturnValue('   ');

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain('No output');
  });

  it('returns 404 if project path not found', async () => {
    getJobMock.mockReturnValue(makeJob());
    resolveProjectPathMock.mockReturnValue(null);

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('starts fix job and returns job info', async () => {
    getJobMock.mockReturnValue(makeJob());

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.job_id).toBeTruthy();
    expect(data.pid).toBeDefined();
  });

  it('calls createJob and updateJob', async () => {
    getJobMock.mockReturnValue(makeJob());

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(createJobMock).toHaveBeenCalledOnce();
    expect(updateJobMock).toHaveBeenCalledOnce();
  });

  it('starts the fix via the job runner after provider gating', async () => {
    getJobMock.mockReturnValue(makeJob({ provider: 'claude' }));

    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(checkCliStartGateMock).toHaveBeenCalledWith('start a fix job', { parentJobId: 'job-source' });
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, command, prompt, cwd] = startJobMock.mock.calls[0];
    expect(command).toContain('/scripts/claude-shim.js');
    expect(command).toContain('--model fast');
    expect(prompt).toContain('Error: something failed');
    expect(cwd).toBe('/path/to/proj');
  });
});

describe('POST /api/jobs/[jobId]/fix weekly quota gating', () => {
  let POST: any;
  let getJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/usage/resolve-provider');
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-job-fix-weekly-test-'));

    getJobMock = vi.fn().mockReturnValue(makeJob());
    startJobMock = vi.fn().mockResolvedValue(99999);

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

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      probeJobStatus: vi.fn().mockResolvedValue('done'),
      readParsedLog: vi.fn().mockReturnValue('Error: something failed\nline 2'),
      createJob: vi.fn().mockImplementation(() =>
        makeJob({ id: 'fix-job-1', kind: 'fix', pid: 0, logPath: null, finishedAt: null, exitCode: null })
      ),
      updateJob: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
      markDone: vi.fn(),
    }));
    vi.doMock('@/lib/jobs/storage', () => ({
      getJob: getJobMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: vi.fn().mockReturnValue({
        claudeBin: 'claude',
        logDir: join(tempDir, 'logs'),
      }),
      getProjectPipelinePrompts: vi.fn().mockReturnValue({ fixPromptAddendum: '' }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/proj'),
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getPipelineModel: () => 'fast',
      getSettings: vi.fn(() => ({
        default_model: 'fast',
        cli_enabled_providers: ['claude', 'codex'],
        claude_provider: 'claude',
        budget_block_at_pct: 95,
        budget_block_runs_enabled: true,
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
    vi.doMock('@/lib/pipeline/pipeline-lock', () => ({
      acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
      isLockOwnedByActiveRelease: vi.fn().mockReturnValue(false),
    }));

    const mod = await import('@/app/api/jobs/[jobId]/fix/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not 429 a fix run when only weekly quota is hot', async () => {
    const req = new NextRequest('http://localhost/api/jobs/job-source/fix', { method: 'POST' });
    const res = await POST(req, { params: Promise.resolve({ jobId: 'job-source' }) });

    expect(res.status).toBe(200);
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, command] = startJobMock.mock.calls[0];
    expect(command).toContain('/scripts/claude-shim.js');
  });
});
