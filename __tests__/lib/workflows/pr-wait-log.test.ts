import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

const { getJobMock, appendRedactedFileSyncMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  appendRedactedFileSyncMock: vi.fn(),
}));

vi.mock('@/lib/jobs/job-storage', () => ({
  getJob: getJobMock,
}));
vi.mock('@/lib/jobs/redacted-log-writer', () => ({
  appendRedactedFileSync: appendRedactedFileSyncMock,
}));

import { appendLogForJob, findIssueTargetForPostMergeDod } from '@/lib/workflows/phases/pr-wait-log';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'job',
    project: 'p',
    kind: 'pr-wait',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

beforeEach(() => {
  getJobMock.mockReset();
  appendRedactedFileSyncMock.mockReset();
});

describe('appendLogForJob', () => {
  it('appends to the job log path when the job is known', () => {
    getJobMock.mockReturnValue(makeJob({ id: 'jw-1', logPath: '/tmp/jw-1.log' }));
    appendLogForJob('jw-1', 'hello\n');
    expect(appendRedactedFileSyncMock).toHaveBeenCalledWith('/tmp/jw-1.log', 'hello\n');
  });

  it('silently no-ops when the job is unknown', () => {
    getJobMock.mockReturnValue(null);
    appendLogForJob('missing', 'line');
    expect(appendRedactedFileSyncMock).not.toHaveBeenCalled();
  });

  it('silently no-ops when the job has no logPath', () => {
    getJobMock.mockReturnValue(makeJob({ id: 'no-log', logPath: null }));
    appendLogForJob('no-log', 'line');
    expect(appendRedactedFileSyncMock).not.toHaveBeenCalled();
  });

  it('swallows log-write errors (non-fatal contract)', () => {
    getJobMock.mockReturnValue(makeJob({ id: 'jw-1', logPath: '/tmp/jw-1.log' }));
    appendRedactedFileSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    // Must not throw — the surrounding workflow steps depend on this being non-fatal.
    expect(() => appendLogForJob('jw-1', 'line')).not.toThrow();
  });
});

describe('findIssueTargetForPostMergeDod', () => {
  it('returns null when the pr-wait job is not found', () => {
    getJobMock.mockReturnValue(null);
    expect(findIssueTargetForPostMergeDod('missing')).toBeNull();
  });

  it('returns null when the pr-wait has no parent chain', () => {
    getJobMock.mockReturnValueOnce(makeJob({ id: 'jw', parentJobId: null }));
    expect(findIssueTargetForPostMergeDod('jw')).toBeNull();
  });

  it('returns the first ancestor that has both ghIssueNumber and ghIssueRepo', () => {
    // Chain: jw → release (no issue) → run (issue 42, owner/repo)
    const jw = makeJob({ id: 'jw', parentJobId: 'release-1' });
    const release = makeJob({ id: 'release-1', kind: 'release', parentJobId: 'run-1' });
    const run = makeJob({ id: 'run-1', kind: 'run', ghIssueNumber: 42, ghIssueRepo: 'owner/repo', parentJobId: null });
    getJobMock.mockImplementation((id) => {
      if (id === 'jw') return jw;
      if (id === 'release-1') return release;
      if (id === 'run-1') return run;
      return null;
    });
    expect(findIssueTargetForPostMergeDod('jw')).toEqual({ issueNumber: 42, repo: 'owner/repo' });
  });

  it('skips ancestors that have only ghIssueNumber (no repo)', () => {
    // Edge: partial stamping. Walk past the incomplete row to the fully-stamped one.
    const jw = makeJob({ id: 'jw', parentJobId: 'a' });
    const partial = makeJob({ id: 'a', ghIssueNumber: 1, ghIssueRepo: null, parentJobId: 'b' });
    const full = makeJob({ id: 'b', ghIssueNumber: 7, ghIssueRepo: 'o/r', parentJobId: null });
    getJobMock.mockImplementation((id) => ({ jw, a: partial, b: full }[id as 'jw' | 'a' | 'b']) ?? null);
    expect(findIssueTargetForPostMergeDod('jw')).toEqual({ issueNumber: 7, repo: 'o/r' });
  });

  it('returns null and does not loop forever on a corrupted parent cycle', () => {
    // Regression guard for the seen-set cycle guard. Without it, a parent
    // chain pointing back to itself would hang the whole pr-wait phase.
    const a = makeJob({ id: 'jw', parentJobId: 'a' });
    const cycle = makeJob({ id: 'a', parentJobId: 'a' }); // points at itself
    getJobMock.mockImplementation((id) => ({ jw: a, a: cycle }[id as 'jw' | 'a']) ?? null);
    expect(findIssueTargetForPostMergeDod('jw')).toBeNull();
  });
});
