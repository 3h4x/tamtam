import { describe, it, expect } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  markReleaseWorkflowDriven,
  isWorkflowDriven,
} from '@/lib/workflows/workflow-driven-flag';

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'j',
    project: 'p',
    kind: 'release',
    pid: 0,
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
    releaseId: null,
    abortedAt: null,
    releaseDeadlineAt: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: null,
    provider: null,
    ...overrides,
  } as JobData;
}

describe('markReleaseWorkflowDriven', () => {
  it('stamps workflowDriven=true on a release with empty contextMeta', () => {
    const release = makeJob({ kind: 'release', contextMeta: null });
    const meta = markReleaseWorkflowDriven(release);
    expect(meta).toEqual({ workflowDriven: true });
    expect(release.contextMeta).toBe('{"workflowDriven":true}');
  });

  it('preserves existing contextMeta fields', () => {
    const release = makeJob({
      kind: 'release',
      contextMeta: JSON.stringify({ issueNumber: 42, releaseStopReason: 'manual abort' }),
    });
    markReleaseWorkflowDriven(release);
    const parsed = JSON.parse(release.contextMeta!);
    expect(parsed).toEqual({
      issueNumber: 42,
      releaseStopReason: 'manual abort',
      workflowDriven: true,
    });
  });

  it('is idempotent — re-stamping does not change the contextMeta string', () => {
    const release = makeJob({
      kind: 'release',
      contextMeta: JSON.stringify({ workflowDriven: true, issueNumber: 5 }),
    });
    const before = release.contextMeta;
    const meta = markReleaseWorkflowDriven(release);
    expect(release.contextMeta).toBe(before);
    expect(meta).toMatchObject({ workflowDriven: true, issueNumber: 5 });
  });

  it('treats malformed contextMeta as empty and stamps anyway', () => {
    const release = makeJob({ kind: 'release', contextMeta: 'not-valid-json{' });
    markReleaseWorkflowDriven(release);
    expect(JSON.parse(release.contextMeta!)).toEqual({ workflowDriven: true });
  });

  it('treats array contextMeta as empty (defensive — we only accept objects)', () => {
    const release = makeJob({ kind: 'release', contextMeta: '[1,2,3]' });
    markReleaseWorkflowDriven(release);
    expect(JSON.parse(release.contextMeta!)).toEqual({ workflowDriven: true });
  });
});

describe('isWorkflowDriven', () => {
  const NO_LOOKUP = () => null;

  it('returns true for a release with workflowDriven flag', () => {
    const release = makeJob({
      kind: 'release',
      contextMeta: JSON.stringify({ workflowDriven: true }),
    });
    expect(isWorkflowDriven(release, NO_LOOKUP)).toBe(true);
  });

  it('returns false for a release without the flag', () => {
    const release = makeJob({
      kind: 'release',
      contextMeta: JSON.stringify({ issueNumber: 99 }),
    });
    expect(isWorkflowDriven(release, NO_LOOKUP)).toBe(false);
  });

  it('returns false for a release with null contextMeta', () => {
    const release = makeJob({ kind: 'release', contextMeta: null });
    expect(isWorkflowDriven(release, NO_LOOKUP)).toBe(false);
  });

  it('looks up release parent for sub-step jobs', () => {
    const release = makeJob({
      id: 'release-1',
      kind: 'release',
      contextMeta: JSON.stringify({ workflowDriven: true }),
    });
    const test = makeJob({
      id: 'test-1',
      kind: 'test',
      releaseId: 'release-1',
    });
    const lookup = (id: string) => (id === 'release-1' ? release : null);
    expect(isWorkflowDriven(test, lookup)).toBe(true);
  });

  it('returns false when sub-step has no releaseId', () => {
    const test = makeJob({ id: 'orphan', kind: 'test', releaseId: null });
    expect(isWorkflowDriven(test, NO_LOOKUP)).toBe(false);
  });

  it('returns false when release parent lookup fails', () => {
    const test = makeJob({ id: 'test-1', kind: 'test', releaseId: 'missing' });
    expect(isWorkflowDriven(test, () => null)).toBe(false);
  });

  it('returns false when release parent exists but lacks the flag', () => {
    const release = makeJob({
      id: 'release-1',
      kind: 'release',
      contextMeta: JSON.stringify({ issueNumber: 1 }),
    });
    const test = makeJob({ id: 'test-1', kind: 'test', releaseId: 'release-1' });
    expect(isWorkflowDriven(test, () => release)).toBe(false);
  });

  it('treats malformed release contextMeta as no-flag', () => {
    const release = makeJob({
      id: 'release-1',
      kind: 'release',
      contextMeta: 'not-json',
    });
    const test = makeJob({ id: 'test-1', kind: 'test', releaseId: 'release-1' });
    expect(isWorkflowDriven(test, () => release)).toBe(false);
  });

  it('matches release-kind jobs by their own contextMeta even when releaseId is set', () => {
    // Defensive: a release meta-job could in theory have releaseId pointing
    // at itself or some odd legacy value. Source-of-truth for release jobs
    // is their own contextMeta, not a recursive lookup.
    const release = makeJob({
      id: 'release-1',
      kind: 'release',
      releaseId: 'release-1',
      contextMeta: JSON.stringify({ workflowDriven: true }),
    });
    expect(isWorkflowDriven(release, () => release)).toBe(true);
  });
});
