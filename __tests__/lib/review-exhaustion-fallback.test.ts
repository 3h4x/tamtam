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
  let parsedLog: string;

  function resp(exitCode: number, stdout = '', stderr = '') {
    return Promise.resolve({ exitCode, stdout, stderr });
  }

  beforeEach(() => {
    vi.resetModules();
    parsedLog = REVIEW_LOG;
    execMock = vi.fn();
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/path/to/tamtam'),
      clearProjectDataCache: vi.fn(),
    }));
    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }));
    vi.doMock('@/lib/jobs/verdict', () => ({
      readLog: vi.fn().mockReturnValue(REVIEW_LOG),
      getVerdict: vi.fn(),
      readParsedLog: vi.fn(() => parsedLog),
    }));
  });

  it('files an issue with all extracted Finding IDs and the canonical labels', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))                          // gh repo view
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'tamtam' }, { name: 'review-followup' }, { name: 'priority-medium' }]))) // gh label list
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/42\n')); // gh issue create

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());

    expect(r).toEqual({ ok: true, issueNumber: 42, issueUrl: 'https://github.com/owner/repo/issues/42' });

    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    expect(createCall).toBeTruthy();
    const labelListCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('label') && a.includes('list'));
    expect(labelListCall).toBeTruthy();
    expect(labelListCall![1]).toEqual(expect.arrayContaining(['--limit', '1000']));
    const args = createCall![1];
    expect(args).toContain('-R');
    expect(args).toContain('owner/repo');
    const titleIdx = args.indexOf('--title');
    // Title must NOT carry release/job/reason metadata — only the count.
    expect(args[titleIdx + 1]).toBe('chore(review): 3 unresolved review findings');
    const bodyIdx = args.indexOf('--body');
    const body = args[bodyIdx + 1];
    expect(body).toContain('missing-error-handling');
    expect(body).toContain('stale-cache');
    expect(body).toContain('hardcoded-secret');
    // Structured rendering: severities and root causes appear; raw stream-json never does.
    expect(body).toContain('severity: medium');
    expect(body).toContain("API route doesn't handle DB timeout");
    expect(body).toContain('## Problem');
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('- [ ] Each finding above is addressed in the implementation and covered by tests.');
    expect(body).toContain('- [ ] A fresh review on this branch returns LGTM with no Finding IDs re-flagged.');
    // Approach section is gone now; the body lists findings under Problem.
    expect(body).not.toContain('## Approach');
    // No invocation metadata: no release handle, no review job id, no reason label.
    expect(body).not.toContain('Release `');
    expect(body).not.toContain('review job');
    expect(body).not.toContain('iteration cap');
    expect(body).not.toContain('carried over');
    expect(body).not.toContain('TamTam');
    // No stream-json telemetry or shim/permission flags.
    expect(body).not.toContain('stream_event');
    expect(body).not.toContain('content_block_delta');
    expect(body).not.toContain('[tamtam] launching');
    expect(body).not.toContain('--permission-mode');
    expect(body).not.toContain('bypassPermissions');
    // labels must include the three canonical tags
    const labels = args.reduce<string[]>((acc, v, i) => (args[i - 1] === '--label' ? [...acc, v] : acc), []);
    expect(labels).toEqual(expect.arrayContaining(['tamtam', 'review-followup', 'priority-medium']));
  });

  it('scrubs invocation and permission details out of structured Finding fields', async () => {
    parsedLog = [
      '- Finding ID: leaked-structured-field',
      '  Severity: high',
      '  Root cause: Handler accepts unsafe input while --permission-mode bypassPermissions was present.',
      '  Affected paths: {"type":"stream_event","payload":{"text":"content_block_delta"}}',
      '  Required fix: Preserve this safe remediation note and remove bypassPermissions details.',
      '  Required tests: [tamtam] launching: /path/to/scripts/codex-shim.js --permission-mode bypassPermissions',
      '',
      'Verdict: NEEDS ATTENTION',
    ].join('\n');
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'tamtam' }, { name: 'review-followup' }, { name: 'priority-medium' }])))
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/43\n'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(true);

    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    const body = createCall![1][createCall![1].indexOf('--body') + 1];
    expect(body).toContain('leaked-structured-field');
    expect(body).toContain('Handler accepts unsafe input while was present.');
    expect(body).toContain('Preserve this safe remediation note and remove details.');
    expect(body).not.toContain('[tamtam] launching');
    expect(body).not.toContain('--permission-mode');
    expect(body).not.toContain('bypassPermissions');
    expect(body).not.toContain('stream_event');
    expect(body).not.toContain('content_block_delta');
    expect(body).not.toContain('codex-shim.js');
  });

  it('returns ok:false when gh repo view fails (no GitHub remote)', async () => {
    execMock.mockImplementationOnce(() => resp(1, '', 'no remote'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when gh repo view returns no shell result', async () => {
    execMock.mockImplementationOnce(() => Promise.resolve(undefined));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r).toEqual({ ok: false, error: 'could not resolve GitHub repo for project' });
  });

  it('returns ok:false when gh issue create fails', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'tamtam' }, { name: 'review-followup' }, { name: 'priority-medium' }])))
      .mockImplementationOnce(() => resp(1, '', 'rate limit'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('rate limit');
  });

  it('returns ok:false when the project path cannot be resolved', async () => {
    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(null),
      clearProjectDataCache: vi.fn(),
    }));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(false);
  });

  it('falls back to a quoted prose excerpt when reviewer emitted no structured Finding blocks', async () => {
    parsedLog = 'General concerns about secret handling, but no structured findings emitted.\n\nVerdict: NEEDS ATTENTION';
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'tamtam' }, { name: 'review-followup' }, { name: 'priority-medium' }])))
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/7\n'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issueNumber).toBe(7);
    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    const args = createCall![1];
    const titleIdx = args.indexOf('--title');
    // Empty-findings title is the bare "unresolved review" form — no metadata.
    expect(args[titleIdx + 1]).toBe('chore(review): unresolved review');
    const body = args[args.indexOf('--body') + 1];
    expect(body).toContain('General concerns about secret handling');
    // Verdict line is stripped from the prose fallback.
    expect(body).not.toContain('Verdict: NEEDS ATTENTION');
    // Still no stream-json telemetry leaks through.
    expect(body).not.toContain('stream_event');
  });

  it('scrubs invocation/permission flags out of the prose fallback', async () => {
    // A pathological reviewer log that survives parsing but contains shim
    // launch lines and dangerous permission flags. The scrubber must drop
    // those lines before they reach the issue body.
    parsedLog = [
      '[tamtam] launching: /path/to/scripts/codex-shim.js --permission-mode bypassPermissions',
      'Reviewer noted concerns about input sanitisation in the new handler.',
      '--permission-mode bypassPermissions was passed to the shim.',
      'No structured findings were emitted this iteration.',
      '',
      'Verdict: NEEDS ATTENTION',
    ].join('\n');
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'tamtam' }, { name: 'review-followup' }, { name: 'priority-medium' }])))
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/8\n'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());
    expect(r.ok).toBe(true);
    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    const body = createCall![1][createCall![1].indexOf('--body') + 1];
    expect(body).toContain('Reviewer noted concerns about input sanitisation');
    expect(body).toContain('No structured findings were emitted this iteration');
    expect(body).not.toContain('[tamtam] launching');
    expect(body).not.toContain('--permission-mode');
    expect(body).not.toContain('bypassPermissions');
    expect(body).not.toContain('codex-shim.js');
  });

  it('skips missing labels and still files the follow-up issue', async () => {
    execMock
      .mockImplementationOnce(() => resp(0, 'owner/repo'))
      .mockImplementationOnce(() => resp(0, JSON.stringify([{ name: 'review-followup' }])))
      .mockImplementationOnce(() => resp(0, 'https://github.com/owner/repo/issues/9\n'));

    const { fileReviewExhaustionIssue } = await import('@/lib/pipeline/review-exhaustion-fallback');
    const r = await fileReviewExhaustionIssue(makeReviewJob());

    expect(r).toEqual({ ok: true, issueNumber: 9, issueUrl: 'https://github.com/owner/repo/issues/9' });
    const createCall = (execMock.mock.calls as [string, string[]][]).find(([cmd, a]) => cmd === 'gh' && a.includes('issue') && a.includes('create'));
    expect(createCall).toBeTruthy();
    const args = createCall![1];
    const labels = args.reduce<string[]>((acc, v, i) => (args[i - 1] === '--label' ? [...acc, v] : acc), []);
    expect(labels).toEqual(['review-followup']);
  });
});
