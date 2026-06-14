import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as schema from '@/lib/db/schema';
import { JobData } from '@/lib/jobs/job-storage';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getSharedHandle, makeMissingProcessError } from './job-storage-probe-fixtures';

describe('probeJobStatus', () => {
  let probeJobStatusFn: typeof import('@/lib/jobs/job-storage').probeJobStatus;
  const resolveProjectPathMock = vi.fn();
  let storageCache: Map<string, JobData>;
  let tempDir: string;
  let jobSeq = 0;

  function nextJobId(label: string): string {
    return `${label}-${++jobSeq}`;
  }

  function writeProbeLog(name: string, contents: string): string {
    const logFile = join(tempDir, `${name}-${++jobSeq}.log`);
    writeFileSync(logFile, contents);
    return logFile;
  }

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('@/lib/db', () => ({ db: getSharedHandle().db, schema }));
    vi.doMock('@/lib/shared/project-data', () => ({ resolveProjectPath: resolveProjectPathMock }));

    const mod = await import('@/lib/jobs/job-storage');
    probeJobStatusFn = mod.probeJobStatus;
    storageCache = (await import('@/lib/jobs/storage')).jobsCache;
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-probe-status-'));
  });

  beforeEach(async () => {
    storageCache.clear();
    resolveProjectPathMock.mockReset().mockReturnValue(null);
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.doUnmock('@/lib/db');
    vi.doUnmock('@/lib/shared/project-data');
    vi.resetModules();
  });

  it('returns running for pid>0 jobs whose process is still alive', async () => {
    const job: JobData = {
      id: nextJobId('job-alive'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: process.pid, // guaranteed alive
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it('marks done for pid>0 jobs whose process is gone', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });
    const job: JobData = {
      id: nextJobId('job-dead'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.finishedAt).not.toBeNull();
      expect(job.exitCode).toBe(-1);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('marks done via process.kill when pid no longer exists', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });

    const job: JobData = {
      id: nextJobId('job-dead-pid'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 99999,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('marks done with exit 0 when log has a clean claude result line (is_error:false)', async () => {
    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":500,"total_cost_usd":0,"session_id":"s1","result":"ok"}';
    const logFile = writeProbeLog('exitcode-override', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-override'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    // getClaudeResultExitCode fires first: log has "type":"result" with is_error:false → markDone(0)
    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(0);
  });

  it('uses exit code 1 when log result has is_error:true (e.g. API timeout)', async () => {
    const resultLine = '{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":1000,"total_cost_usd":0,"session_id":"s2","result":"Stream idle timeout"}';
    const logFile = writeProbeLog('is-error', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-is-error'),
      project: 'proj',
      kind: 'run',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    // getClaudeResultExitCode fires first: log has "type":"result" with is_error:true → markDone(1)
    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(1);
  });

  it('uses exit code 1 for is_error:true on agent: kind too', async () => {
    const resultLine = '{"type":"result","subtype":"error_api","is_error":true,"duration_ms":500,"total_cost_usd":0,"session_id":"s3","result":"Rate limited"}';
    const logFile = writeProbeLog('agent-is-error', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-agent-is-error'),
      project: 'proj',
      kind: 'agent:my-agent',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(1);
  });

  it('does NOT apply claude result-line override for test kind', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeMissingProcessError();
    });

    const resultLine = '{"type":"result","subtype":"success","is_error":false,"duration_ms":200,"total_cost_usd":0,"session_id":"s3","result":"ok"}';
    const logFile = writeProbeLog('test-kind', resultLine + '\n');

    const job: JobData = {
      id: nextJobId('job-test-kind'),
      project: 'proj',
      kind: 'test',
      prompt: null,
      pid: 9999,
      logPath: logFile,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    try {
      // The claude result-line override only fires for claude-backed kinds.
      // Test kind falls through to process.kill liveness; dead pid + no
      // sentinel file → markDone(-1).
      const status = await probeJobStatusFn(job);
      expect(status).toBe('done');
      expect(job.exitCode).toBe(-1);
    } finally {
      killSpy.mockRestore();
    }
  });

  // Regression: an `agent:*` job created via createJob(project, kind, 0, '')
  // spends hundreds of ms before updateJob persists the real pid. A concurrent
  // duplicate-check (/api/agents/[id]/run) would call probeJobStatus on the
  // in-flight sibling, hit the pid<=0 fast-path, and markDone(-1) — which
  // also tears down the nascent process. User symptom: phantom
  // "exit -1 @ 0s" row next to the successful run.
  it("returns 'running' for a freshly-created pid=0 job (spawn grace)", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
    expect(job.exitCode).toBeNull();
  });

  it("returns 'done' and marks exit -1 once a pid=0 job exceeds the spawn grace", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace-expired'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: 0,
      logPath: null,
      // 60 s ago — well past the 30 s grace window.
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  it("returns 'running' for a freshly-created pid=-1 job (negative pid within grace)", async () => {
    // pid can be -1 when createJob writes a placeholder before the spawn
    // returns. The grace window applies to all pid<=0, not just pid===0.
    const job: JobData = {
      id: nextJobId('job-spawn-grace-neg'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });

  it("returns 'done' for a pid=-1 job that exceeds the spawn grace", async () => {
    const job: JobData = {
      id: nextJobId('job-spawn-grace-neg-expired'),
      project: 'proj',
      kind: 'agent:docs',
      prompt: null,
      pid: -1,
      logPath: null,
      startedAt: Date.now() / 1000 - 60,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('done');
    expect(job.exitCode).toBe(-1);
    expect(job.finishedAt).not.toBeNull();
  });

  it('release kind always reports running — workflow runtime owns finalization', async () => {
    const job: JobData = {
      id: nextJobId('release-running'),
      project: 'proj',
      kind: 'release',
      prompt: null,
      pid: 0,
      logPath: null,
      startedAt: Date.now() / 1000 - 120,
      finishedAt: null,
      exitCode: null,
      seen: false,
    };

    const status = await probeJobStatusFn(job);
    expect(status).toBe('running');
    expect(job.finishedAt).toBeNull();
  });
});
