import { describe, it, expect } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import { findNextSubStepJob } from '@/lib/workflows/find-next-substep';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'j',
    project: 'p',
    kind: 'test',
    pid: 12345,
    logPath: null,
    prompt: null,
    startedAt: 100,
    finishedAt: null,
    exitCode: null,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    userPrompt: null,
    contextMeta: null,
    parentJobId: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    verdict: null,
    costUsd: null,
    model: null,
    releaseId: 'release-1',
    abortedAt: null,
    releaseDeadlineAt: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: null,
    provider: null,
    ...overrides,
  } as JobData;
}

describe('findNextSubStepJob', () => {
  it('returns null when prev has no finishedAt', () => {
    const prev = makeJob({ id: 'prev', finishedAt: null });
    const r = findNextSubStepJob([prev], prev);
    expect(r).toBeNull();
  });

  it('returns null when no candidate exists', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev], prev);
    expect(r).toBeNull();
  });

  it('returns a sibling with matching releaseId that started after prev finished', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const next = makeJob({ id: 'next', startedAt: 201, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev, next], prev);
    expect(r?.id).toBe('next');
  });

  it('ignores siblings from a different release', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const otherRelease = makeJob({ id: 'other', startedAt: 250, releaseId: 'release-2' });
    const r = findNextSubStepJob([prev, otherRelease], prev);
    expect(r).toBeNull();
  });

  it('treats prev.id as the releaseId when prev IS the release meta-job', () => {
    // The release meta-job's own releaseId column is null; its children's
    // releaseId points at the meta-job's id.
    const prev = makeJob({ id: 'release-meta-1', kind: 'release', finishedAt: 200, releaseId: null });
    const child = makeJob({ id: 'child', startedAt: 201, releaseId: 'release-meta-1' });
    const r = findNextSubStepJob([prev, child], prev);
    expect(r?.id).toBe('child');
  });

  it('picks the most-recently-started candidate when multiple match', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const a = makeJob({ id: 'a', startedAt: 210, releaseId: 'release-1' });
    const b = makeJob({ id: 'b', startedAt: 220, releaseId: 'release-1' });
    const c = makeJob({ id: 'c', startedAt: 215, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev, a, b, c], prev);
    expect(r?.id).toBe('b');
  });

  it('rejects siblings that started before prev.finishedAt by more than slack', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const tooEarly = makeJob({ id: 'early', startedAt: 50, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev, tooEarly], prev);
    expect(r).toBeNull();
  });

  it('accepts siblings within the default 1s slack window (clock skew)', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    // 0.5s before prev.finishedAt — within the default 1s slack.
    const justBefore = makeJob({ id: 'just-before', startedAt: 199.5, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev, justBefore], prev);
    expect(r?.id).toBe('just-before');
  });

  it('honors a custom clockSkewSlackSec option', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const candidate = makeJob({ id: 'cand', startedAt: 195, releaseId: 'release-1' });
    expect(findNextSubStepJob([prev, candidate], prev)).toBeNull();
    expect(findNextSubStepJob([prev, candidate], prev, { clockSkewSlackSec: 10 })?.id).toBe('cand');
  });

  it('does not include prev itself in candidates', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1', startedAt: 100 });
    const r = findNextSubStepJob([prev], prev);
    expect(r).toBeNull();
  });

  it('skips candidates without a numeric startedAt', () => {
    const prev = makeJob({ id: 'prev', finishedAt: 200, releaseId: 'release-1' });
    const noStart = makeJob({ id: 'no-start', startedAt: NaN as unknown as number, releaseId: 'release-1' });
    const r = findNextSubStepJob([prev, noStart], prev);
    expect(r).toBeNull();
  });
});
