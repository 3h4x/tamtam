import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';

function makeReviewJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: 'tamtam-review-1778166600000000',
    project: 'tamtam',
    kind: 'review',
    pid: 99999,
    prompt: '',
    logPath: '/tmp/review.log',
    status: 'done',
    abortedAt: null,
    exitCode: 0,
    startedAt: 1778166600,
    finishedAt: 1778166700,
    seen: false,
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    sessionId: null,
    contextMeta: null,
    userPrompt: null,
    costUsd: null,
    model: null,
    ghIssueNumber: null,
    ghIssueRepo: null,
    ghIssueTitle: null,
    logPruned: false,
    releaseId: 'tamtam-release-1778166600000000',
    parentJobId: null,
    promptBytes: null,
    workSummary: null,
    modifiedFiles: null,
    provider: 'claude',
    ...overrides,
  } as unknown as JobData;
}

const REVIEW_LOG = `
Some preamble text...

- Finding ID: missing-error-handling
  Severity: medium
  Root cause: API route doesn't handle DB timeout

- Finding ID: stale-cache
  Severity: low
  Root cause: cache TTL not respected

- Finding ID: hardcoded-secret
  Severity: high
  Root cause: token in committed config

Verdict: NEEDS ATTENTION
`;

describe('fileReviewExhaustionIssue', () => {
  let execMock: ReturnType<typeof vi.fn>;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(() => {
    vi.resetModules();
    execMock = vi.fn();
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/tamtam'),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/verdict', () => ({
      readLog: vi.fn().mockReturnValue(REVIEW_LOG),
      getVerdict: vi.fn(),
      readParsedLog: vi.fn(),
    }));
  });

  it('files an issue with all extracted Finding IDs and the canonical labels', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))                          // gh repo view
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/42\n')); // gh issue create

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'review-cap');

    expect(r).toEqual({ ok: true, issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' });

    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    expect(createCall).toBeTruthy();
    const args = createCall![1];
    expect(args).toContain('-R');
    expect(args).toContain('owner/repo');
    const titleIdx = args.indexOf('--title');
    expect(args[titleIdx + 1]).toMatch(/finish review findings from release/);
    const bodyIdx = args.indexOf('--body');
    const body = args[bodyIdx + 1];
    expect(body).toContain('missing-error-handling');
    expect(body).toContain('stale-cache');
    expect(body).toContain('hardcoded-secret');
    expect(body).not.toContain('was committed and pushed');
    expect(body).toContain('Check the release log for whether the partial work was ultimately committed or pushed');
    expect(body).toContain('## Problem');
    expect(body).toContain('## Approach');
    expect(body).toContain('## Acceptance criteria');
    // labels must include the three canonical tags
    const labels = args.reduce<string[]>((acc, v, i) => (args[i - 1] === '--label' ? [...acc, v] : acc), []);
    expect(labels).toEqual(expect.arrayContaining(['tamtam', 'review-followup', 'priority-medium']));
  });

  it('returns ok:false when gh repo view fails (no GitHub remote)', async () => {
    execMock.mockImplementationOnce(() => resp(1, '', 'no remote'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'review-stuck');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when gh repo view returns no shell result', async () => {
    execMock.mockImplementationOnce(() => Promise.resolve(undefined));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'review-stuck');
    expect(r).toEqual({ ok: false, error: 'could not resolve GitHub repo for project' });
  });

  it('returns ok:false when gh issue create fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(1, '', 'rate limit'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'fix-contradicts-review');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('rate limit');
  });

  it('returns ok:false when the project path cannot be resolved', async () => {
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
      clearProjectDataCache: vi.fn(),
    }));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'review-cap');
    expect(r.ok).toBe(false);
  });

  it('still files an issue with empty Finding IDs section when reviewer emitted no Finding IDs', async () => {
    vi.doMock('@/lib/jobs/verdict', () => ({
      readLog: vi.fn().mockReturnValue('General concerns, but no structured findings.\n\nVerdict: NEEDS ATTENTION'),
      getVerdict: vi.fn(),
      readParsedLog: vi.fn(),
    }));
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/7\n'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob(), 'review-cap');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issueNumber).toBe(7);
  });
});
