import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeJobLogs, readJobLogs, cleanupOldLogs } from '@/lib/jobs/log-persistence';

describe('log-persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes and reads frames', () => {
    const frames = [
      { type: 'stdout', content: 'hello', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'stderr', content: 'error', timestamp: '2024-01-01T00:00:01Z' },
    ];
    writeJobLogs('test-job', frames, tempDir);
    const read = readJobLogs('test-job', tempDir);
    expect(read).toEqual(frames);
  });

  it('redacts secrets before storing frames', () => {
    writeJobLogs('secret-job', [
      {
        type: 'stdout',
        content: 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 visible text',
        timestamp: '2024-01-01T00:00:00Z',
      },
    ], tempDir);

    const read = readJobLogs('secret-job', tempDir);
    expect(read[0].content).toBe('token=[REDACTED] visible text');
  });

  it('returns empty for missing job', () => {
    expect(readJobLogs('nonexistent', tempDir)).toEqual([]);
  });

  it('cleans up old logs', () => {
    for (let i = 0; i < 5; i++) {
      writeJobLogs(`job-${i}`, [{ type: 'stdout', content: `${i}`, timestamp: '' }], tempDir);
    }
    cleanupOldLogs(3, tempDir);
    const remaining = readJobLogs('job-0', tempDir);
    // job-0 and job-1 should be deleted (oldest)
    expect(remaining).toEqual([]);
    expect(readJobLogs('job-4', tempDir).length).toBe(1);
  });

  it('skips logs that vanish while cleanup stats entries', async () => {
    vi.resetModules();
    const unlinkSyncMock = vi.fn();
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => ['gone.log', 'old.log', 'keep.log']),
        statSync: vi.fn((path: string) => {
          if (path.endsWith('gone.log')) {
            const error = new Error('missing') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return { mtimeMs: path.endsWith('old.log') ? 1 : 2 };
        }),
        unlinkSync: unlinkSyncMock,
      };
    });

    try {
      const { cleanupOldLogs: cleanupWithMockedFs } = await import('@/lib/jobs/log-persistence');

      cleanupWithMockedFs(1, '/tmp/tamtam-test');

      expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
      expect(unlinkSyncMock.mock.calls[0]?.[0]).toContain('old.log');
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });
});
