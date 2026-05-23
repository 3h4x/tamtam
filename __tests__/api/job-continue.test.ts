import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { JobData } from '@/lib/jobs/job-storage';

const NOW = 2_000_000_000_000;

function makeJob(overrides: Partial<JobData> = {}): JobData {
  const finishedAtSec = (NOW - 60_000) / 1000;
  return {
    id: 'job-source',
    project: 'proj1',
    kind: 'agent:improve-speed',
    prompt: null,
    pid: 1234,
    logPath: null,
    startedAt: finishedAtSec - 600,
    finishedAt: finishedAtSec,
    exitCode: 1,
    seen: false,
    sessionId: 'sess-abc',
    provider: 'claude',
    ...overrides,
  } as JobData;
}

describe('POST /api/jobs/{jobId}/continue', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) => Promise<Response>;
  let getJobMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let startJobMock: ReturnType<typeof vi.fn>;
  let findBlockingRunningJobMock: ReturnType<typeof vi.fn>;
  let withBasePromptMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    getJobMock = vi.fn().mockReturnValue(null);
    createJobMock = vi.fn().mockImplementation((project: string, kind: string) => ({
      id: 'job-continued', project, kind, finishedAt: null, exitCode: null,
    }));
    updateJobMock = vi.fn();
    startJobMock = vi.fn().mockResolvedValue(9999);
    findBlockingRunningJobMock = vi.fn().mockResolvedValue(null);
    withBasePromptMock = vi.fn((p: string) => `BASE\n\n---\n\n${p}`);

    vi.doMock('@/lib/jobs/job-storage', () => ({
      getJob: getJobMock,
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-logs' }),
    }));
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: () => '/path/to/proj',
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      getSettings: () => ({}),
      withBasePrompt: withBasePromptMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: vi.fn().mockResolvedValue({ ok: true, provider: 'claude' }),
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: () => 'claude',
      resolveCliEnv: () => ({}),
      resolveCliDefaultModel: () => 'smart',
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: findBlockingRunningJobMock,
    }));

    const mod = await import('@/app/api/jobs/[jobId]/continue/route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('404 when source job missing', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(404);
  });

  it('400 when kind is not resumable (e.g. release)', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'release' }));
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(400);
  });

  it('400 when sessionId is missing', async () => {
    getJobMock.mockReturnValue(makeJob({ sessionId: null as unknown as string }));
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(400);
  });

  it('409 when source job is still running', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: null }));
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(409);
  });

  it('410 when source job finished more than 30 min ago', async () => {
    getJobMock.mockReturnValue(makeJob({ finishedAt: (NOW - 31 * 60 * 1000) / 1000 }));
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(410);
  });

  it('409 when another job is running for the project', async () => {
    getJobMock.mockReturnValue(makeJob());
    findBlockingRunningJobMock.mockResolvedValue({ id: 'other', kind: 'review' });
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/x/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'x' }) },
    );
    expect(res.status).toBe(409);
  });

  it('starts a new job with --resume <sessionId> and base prompt', async () => {
    getJobMock.mockReturnValue(makeJob());
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/job-source/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-source' }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('started');
    expect(data.resumed_session_id).toBe('sess-abc');
    expect(startJobMock).toHaveBeenCalledOnce();
    const [, cmd, prompt] = startJobMock.mock.calls[0];
    expect(cmd).toContain('--resume sess-abc');
    expect(cmd).toContain('--print');
    expect(withBasePromptMock).toHaveBeenCalled();
    expect(prompt.startsWith('BASE')).toBe(true);
  });

  it('reconstructs the session id from the log tail when the job row is missing it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-continue-'));
    try {
      const logPath = join(tempDir, 'source.log');
      writeFileSync(logPath, '{"type":"assistant","session_id":"12345678-1234-1234-1234-123456789abc"}\n');
      getJobMock.mockReturnValue(makeJob({ sessionId: null, logPath }));

      const res = await POST(
        new NextRequest('http://localhost/api/jobs/job-source/continue', { method: 'POST' }),
        { params: Promise.resolve({ jobId: 'job-source' }) },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resumed_session_id).toBe('12345678-1234-1234-1234-123456789abc');
      const [, cmd] = startJobMock.mock.calls[0];
      expect(cmd).toContain('--resume 12345678-1234-1234-1234-123456789abc');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves source kind on the continuation job', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'agent:test-improve' }));
    await POST(
      new NextRequest('http://localhost/api/jobs/job-source/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-source' }) },
    );
    expect(createJobMock).toHaveBeenCalledWith(
      'proj1',
      'agent:test-improve',
      0,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'job-source',
    );
  });

  it('accepts kind=run as resumable', async () => {
    getJobMock.mockReturnValue(makeJob({ kind: 'run' }));
    const res = await POST(
      new NextRequest('http://localhost/api/jobs/job-source/continue', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-source' }) },
    );
    expect(res.status).toBe(200);
  });
});
