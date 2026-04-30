import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
