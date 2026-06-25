import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

describe('startJobInProcess', () => {
  let tempDir: string;
  let jobsCache: Map<string, JobData>;
  let saveToDb: ReturnType<typeof vi.fn>;
  let markDone: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let throwOnWrite: boolean;
  let child: EventEmitter & { pid: number; stdin: PassThrough; unref: () => void };
  let cleanup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-detached-agent-'));
    cleanup = vi.fn();
    throwOnWrite = false;
    saveToDb = vi.fn();
    markDone = vi.fn().mockResolvedValue(undefined);
    child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; unref: () => void };
    child.pid = 2468;
    child.stdin = new PassThrough();
    child.unref = vi.fn();
    spawnMock = vi.fn(() => child);
    jobsCache = new Map<string, JobData>([
      ['job-1', {
        id: 'job-1',
        project: 'project',
        kind: 'run',
        prompt: null,
        pid: 0,
        logPath: null,
        startedAt: Date.now() / 1000,
        finishedAt: null,
        exitCode: null,
        seen: false,
      }],
    ]);

    vi.doMock('child_process', () => ({
      spawn: spawnMock,
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          if (throwOnWrite) throw new Error('prompt write failed');
          return actual.writeFileSync(...args);
        },
      };
    });
    vi.doMock('@/lib/scheduling/scheduling', () => ({
      getImproveConfig: () => ({ logDir: tempDir }),
    }));
    vi.doMock('@/lib/jobs/job-storage', () => ({
      jobsCache,
      saveToDb,
      markDone,
    }));
    vi.doMock('@/lib/jobs/prompt-size', () => ({
      measurePrompt: (prompt: string) => Buffer.byteLength(prompt, 'utf8'),
      checkPromptSize: vi.fn(),
      assertPromptEstimateAllowed: vi.fn(),
    }));
    vi.doMock('@/lib/shared/split-command', () => ({
      splitCommand: () => ['claude', '--flag'],
    }));
    vi.doMock('@/lib/shared/sandbox-wrap', () => ({
      wrapForSandbox: (opts: { bin: string; args: string[]; cwd: string; runDir?: string }) => ({
        bin: opts.bin,
        args: opts.args,
        env: {},
      }),
    }));
    vi.doMock('@/lib/shared/child-env', () => ({
      buildChildEnv: (env: Record<string, string>) => env,
    }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps the broker config alive until the detached child exits', async () => {
    const { startJobInProcess } = await import('@/lib/jobs/spawn-claude-detached');

    const pid = await startJobInProcess('job-1', 'claude --flag', 'prompt', tempDir, {
      cleanup: cleanup as unknown as () => void,
    });

    expect(pid).toBe(2468);
    expect(cleanup).not.toHaveBeenCalled();

    child.emit('exit', 0, null);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(markDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 0);
  });

  it('cleans up broker state when startup fails before spawning the child', async () => {
    throwOnWrite = true;
    const { startJobInProcess } = await import('@/lib/jobs/spawn-claude-detached');

    await expect(
      startJobInProcess('job-1', 'claude --flag', 'prompt', tempDir, {
        cleanup: cleanup as unknown as () => void,
      }),
    ).rejects.toThrow('prompt write failed');

    expect(cleanup).toHaveBeenCalledOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
