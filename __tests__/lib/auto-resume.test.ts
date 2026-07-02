import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findSessionIdInLog,
  hasFinalResult,
  isAutoResumeEligible,
  MAX_AUTO_RESUME_ATTEMPTS,
} from '@/lib/jobs/auto-resume';
import { RUN_WALL_TIME_EXIT_CODE, RUN_TOKEN_CAP_EXIT_CODE } from '@/lib/jobs/run-cap-reaper';
import type { JobData } from '@/lib/jobs/job-storage';

const NOW = 2_000_000_000_000;

function jobOf(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'agent-1',
    project: 'p',
    kind: 'agent:frontend',
    prompt: null,
    pid: 123,
    logPath: '/tmp/x.log',
    startedAt: (NOW - 5 * 60_000) / 1000,
    finishedAt: (NOW - 60_000) / 1000,
    exitCode: -1,
    seen: false,
    sessionId: 'sess-1',
    ...overrides,
  } as JobData;
}

describe('findSessionIdInLog', () => {
  it('finds the last session_id in a stream-json tail', () => {
    const buf = `{"session_id":"7abc3cf1-3748-46c3-b4df-cd934795a75f"}\n{"session_id":"7abc3cf1-3748-46c3-b4df-cd934795a75f"}`;
    expect(findSessionIdInLog(buf)).toBe('7abc3cf1-3748-46c3-b4df-cd934795a75f');
  });
  it('returns null when no session_id in tail', () => {
    expect(findSessionIdInLog('just plain text')).toBeNull();
  });
});

describe('hasFinalResult', () => {
  it('detects a result event', () => {
    expect(hasFinalResult('{"type":"result","duration_ms":100}')).toBe(true);
  });
  it('is false for partial stream events', () => {
    expect(hasFinalResult('{"type":"stream_event","event":{...}}')).toBe(false);
  });
});

describe('isAutoResumeEligible', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const partialTail = `{"type":"stream_event","event":{"type":"content_block_delta"}}`;
  const completeTail = `{"type":"result","duration_ms":100,"is_error":false}`;

  it('accepts agent/run job that exited non-zero with no final result', () => {
    expect(isAutoResumeEligible(jobOf(), partialTail)).toBe(true);
  });
  it('accepts non-zero exit even when log has a final result event (ERROR/is_error case)', () => {
    expect(isAutoResumeEligible(jobOf(), completeTail)).toBe(true);
  });
  it('rejects clean (exit 0) jobs', () => {
    expect(isAutoResumeEligible(jobOf({ exitCode: 0 }), partialTail)).toBe(false);
  });
  it('rejects running jobs', () => {
    expect(isAutoResumeEligible(jobOf({ finishedAt: null }), partialTail)).toBe(false);
  });
  it('rejects pipeline-step kinds', () => {
    expect(isAutoResumeEligible(jobOf({ kind: 'review' }), partialTail)).toBe(false);
    expect(isAutoResumeEligible(jobOf({ kind: 'test' }), partialTail)).toBe(false);
  });
  it('rejects jobs finished more than 30 min ago', () => {
    expect(isAutoResumeEligible(jobOf({ finishedAt: (NOW - 31 * 60_000) / 1000 }), partialTail)).toBe(false);
  });
  it('rejects when the chain cap is reached', () => {
    const job = jobOf({
      contextMeta: JSON.stringify({ autoResumeChain: { count: MAX_AUTO_RESUME_ATTEMPTS } }),
    });
    expect(isAutoResumeEligible(job, partialTail)).toBe(false);
  });
  it('accepts run kind', () => {
    expect(isAutoResumeEligible(jobOf({ kind: 'run' }), partialTail)).toBe(true);
  });
  it('rejects a run killed by the token cap (resuming reloads the same oversized session)', () => {
    expect(isAutoResumeEligible(jobOf({ exitCode: RUN_TOKEN_CAP_EXIT_CODE }), partialTail)).toBe(false);
  });
  it('rejects a run killed by the wall-clock cap (resuming re-runs the same slow work)', () => {
    expect(isAutoResumeEligible(jobOf({ exitCode: RUN_WALL_TIME_EXIT_CODE }), partialTail)).toBe(false);
  });
  it('still accepts ordinary non-zero exits that are NOT resource-limit kills (transient crash)', () => {
    expect(isAutoResumeEligible(jobOf({ exitCode: 1 }), partialTail)).toBe(true);
    expect(isAutoResumeEligible(jobOf({ exitCode: -1 }), partialTail)).toBe(true);
  });
});

describe('maybeAutoResume browser broker wiring', () => {
  let maybeAutoResume: typeof import('@/lib/jobs/auto-resume').maybeAutoResume;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let checkCliStartGateMock: ReturnType<typeof vi.fn>;
  let prepareBrokerRunMock: ReturnType<typeof vi.fn>;
  let startJobInProcessMock: ReturnType<typeof vi.fn>;
  let createJobMock: ReturnType<typeof vi.fn>;
  let updateJobMock: ReturnType<typeof vi.fn>;
  let dbRows: Array<Record<string, unknown>>;
  let cleanupMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    resolveProjectPathMock = vi.fn().mockReturnValue('/path/to/proj');
    checkCliStartGateMock = vi.fn().mockResolvedValue({ ok: true, provider: 'claude' });
    cleanupMock = vi.fn();
    prepareBrokerRunMock = vi.fn().mockResolvedValue({
      env: { TAMTAM_BROKER_URL: 'http://127.0.0.1:9000' },
      runDir: '/tmp/tamtam-runs/job-2',
      cleanup: cleanupMock,
    });
    startJobInProcessMock = vi.fn().mockImplementation(async (_jobId: string, _cmd: string, _prompt: string, _cwd: string, options?: { env?: Record<string, string>; cleanup?: () => void }) => {
      expect(options?.env).toMatchObject({
        TAMTAM_BROKER_URL: 'http://127.0.0.1:9000',
      });
      expect(options?.cleanup).toBe(cleanupMock);
      options?.cleanup?.();
      return 12345;
    });
    createJobMock = vi.fn().mockImplementation(() => ({
      id: 'job-2',
      project: 'proj',
      kind: 'agent:frontend',
      prompt: null,
      pid: 0,
      logPath: '/tmp/job-2.log',
      startedAt: NOW / 1000,
      finishedAt: null,
      exitCode: null,
      seen: false,
      sessionId: 'sess-2',
      provider: 'claude',
    }));
    updateJobMock = vi.fn();
    dbRows = [
      {
        qaUrl: 'http://qa.local',
        devServerReadyUrl: 'http://dev.local',
        website: 'http://site.local',
      },
    ];

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));
    vi.doMock('@/lib/usage/resolve-provider', () => ({
      checkCliStartGate: checkCliStartGateMock,
    }));
    vi.doMock('@/lib/shared/config', () => ({
      getSettings: () => ({
        browser_broker_enabled: true,
        browser_broker_image: 'custom/broker:2',
      }),
      getPermissionModeFlag: () => '--permission-mode bypassPermissions',
      withBasePrompt: (p: string) => p,
    }));
    vi.doMock('@/lib/shared/cli-bin', () => ({
      resolveCliBin: () => 'claude',
      resolveCliDefaultModel: () => 'smart',
      resolveCliEnv: () => ({ CLAUDE_BIN: 'claude' }),
    }));
    vi.doMock('@/lib/jobs/project-active-job', () => ({
      findBlockingRunningJob: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      createJob: createJobMock,
      updateJob: updateJobMock,
    }));
    vi.doMock('@/lib/jobs/spawn-claude-detached', () => ({
      startJobInProcess: startJobInProcessMock,
    }));
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: '/tmp/tamtam-logs' }),
    }));
    vi.doMock('@/lib/browser-broker/prepare-run', () => ({
      prepareBrokerRun: prepareBrokerRunMock,
    }));
    vi.doMock('@/lib/db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => dbRows,
            }),
          }),
        }),
      },
      schema: { projects: { name: 'name' } },
    }));
    vi.doMock('drizzle-orm', () => ({
      eq: vi.fn(),
    }));

    ({ maybeAutoResume } = await import('@/lib/jobs/auto-resume'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects broker MCP env and preserves cleanup through resumed launches', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tamtam-auto-resume-'));
    try {
      const logPath = join(tempDir, 'job-source.log');
      writeFileSync(logPath, '{"session_id":"sess-2"}\n');

      const result = await maybeAutoResume({
        id: 'job-source',
        project: 'proj',
        kind: 'run',
        prompt: null,
        pid: 123,
        logPath,
        startedAt: (NOW - 60_000) / 1000,
        finishedAt: NOW / 1000,
        exitCode: 1,
        seen: false,
        sessionId: 'sess-2',
        provider: 'claude',
        model: 'smart',
        contextMeta: JSON.stringify({ autoResumeChain: { count: 0 } }),
      } as JobData);

      expect(result).toEqual({ resumed: true, newJobId: 'job-2' });
      expect(checkCliStartGateMock).toHaveBeenCalledWith('auto-resume', {
        preferred: 'claude',
        strictPreferred: true,
      });
      expect(prepareBrokerRunMock).toHaveBeenCalledOnce();
      expect(startJobInProcessMock).toHaveBeenCalledOnce();
      expect(cleanupMock).toHaveBeenCalledOnce();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
