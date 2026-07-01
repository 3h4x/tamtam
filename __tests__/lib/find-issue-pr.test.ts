import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/github/repo', () => ({ resolveGhRepo: vi.fn(async () => 'owner/repo') }));

import { findOpenPrForIssue } from '@/lib/github/find-issue-pr';

function ghList(prs: unknown[]) {
  return { stdout: JSON.stringify(prs), stderr: '', exitCode: 0 };
}

beforeEach(() => mocks.exec.mockReset());

const base = { project: 'p', projPath: '/tmp/p', issueNumber: 42, issueBranch: 'fix/issue-42-do-thing' };

describe('findOpenPrForIssue', () => {
  it('matches the canonical fix/issue-<n> branch', async () => {
    mocks.exec.mockResolvedValue(ghList([
      { number: 5, headRefName: 'other/thing', url: 'u5', body: '', isDraft: false, closingIssuesReferences: [] },
      { number: 7, headRefName: 'fix/issue-42-do-thing', url: 'u7', body: '', isDraft: false, closingIssuesReferences: [] },
    ]));
    expect(await findOpenPrForIssue(base)).toEqual({ number: 7, branch: 'fix/issue-42-do-thing', url: 'u7' });
  });

  it('matches a structured closing reference even when the branch name is unrelated', async () => {
    mocks.exec.mockResolvedValue(ghList([
      { number: 9, headRefName: 'perf/indexes', url: 'u9', body: 'perf work', isDraft: false, closingIssuesReferences: [{ number: 42 }] },
    ]));
    expect(await findOpenPrForIssue(base)).toEqual({ number: 9, branch: 'perf/indexes', url: 'u9' });
  });

  it('falls back to a close-keyword in the PR body', async () => {
    mocks.exec.mockResolvedValue(ghList([
      { number: 11, headRefName: 'improve/x', url: 'u11', body: 'This closes #42 finally', isDraft: false, closingIssuesReferences: [] },
    ]));
    expect(await findOpenPrForIssue(base)).toEqual({ number: 11, branch: 'improve/x', url: 'u11' });
  });

  it('skips draft PRs', async () => {
    mocks.exec.mockResolvedValue(ghList([
      { number: 13, headRefName: 'fix/issue-42-do-thing', url: 'u13', body: '', isDraft: true, closingIssuesReferences: [] },
    ]));
    expect(await findOpenPrForIssue(base)).toBeNull();
  });

  it('does not match a different issue number (no false positive on #4 vs #42)', async () => {
    mocks.exec.mockResolvedValue(ghList([
      { number: 15, headRefName: 'fix/issue-4-other', url: 'u15', body: 'closes #4', isDraft: false, closingIssuesReferences: [{ number: 4 }] },
    ]));
    expect(await findOpenPrForIssue(base)).toBeNull();
  });

  it('returns null when gh fails', async () => {
    mocks.exec.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });
    expect(await findOpenPrForIssue(base)).toBeNull();
  });
});
