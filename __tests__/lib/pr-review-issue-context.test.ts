import { describe, it, expect, beforeEach, vi } from 'vitest';

const { readIssueBodyMock } = vi.hoisted(() => ({ readIssueBodyMock: vi.fn() }));
vi.mock('@/lib/github/edit-issue-body', () => ({ readIssueBody: readIssueBodyMock }));

import { fetchPrReviewIssueContext } from '@/lib/pipeline/pr-review-issue-context';

describe('fetchPrReviewIssueContext', () => {
  beforeEach(() => {
    readIssueBodyMock.mockReset();
  });

  it('returns the linked issue number and its unchecked acceptance criteria', async () => {
    readIssueBodyMock
      .mockResolvedValueOnce({ ok: true, body: 'Implements the feature.\n\nCloses #10', title: 'PR' })
      .mockResolvedValueOnce({
        ok: true,
        title: 'Feature',
        body: '## Acceptance criteria\n- [ ] Add unit tests\n- [x] Wire the button\n- [ ] Handle errors',
      });

    const ctx = await fetchPrReviewIssueContext('/repo/proj', 'owner/repo', 42);

    expect(ctx).toEqual({ issueNumber: 10, criteria: ['Add unit tests', 'Handle errors'] });
    // First call reads the PR body, second reads the linked issue.
    expect(readIssueBodyMock).toHaveBeenNthCalledWith(1, { projPath: '/repo/proj', repo: 'owner/repo', number: 42, kind: 'pr' });
    expect(readIssueBodyMock).toHaveBeenNthCalledWith(2, { projPath: '/repo/proj', repo: 'owner/repo', number: 10, kind: 'issue' });
  });

  it('returns null when the PR body has no linked issue', async () => {
    readIssueBodyMock.mockResolvedValueOnce({ ok: true, body: 'A PR with no issue reference.', title: 'PR' });

    const ctx = await fetchPrReviewIssueContext('/repo/proj', 'owner/repo', 42);

    expect(ctx).toBeNull();
    expect(readIssueBodyMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the linked issue has no unchecked acceptance criteria', async () => {
    readIssueBodyMock
      .mockResolvedValueOnce({ ok: true, body: 'Fixes #7', title: 'PR' })
      .mockResolvedValueOnce({ ok: true, title: 'Done issue', body: '- [x] All done' });

    const ctx = await fetchPrReviewIssueContext('/repo/proj', 'owner/repo', 42);

    expect(ctx).toBeNull();
  });

  it('returns null (best-effort) when the PR body cannot be read', async () => {
    readIssueBodyMock.mockResolvedValueOnce({ ok: false, detail: 'gh failed' });

    const ctx = await fetchPrReviewIssueContext('/repo/proj', 'owner/repo', 42);

    expect(ctx).toBeNull();
  });

  it('swallows unexpected errors and returns null', async () => {
    readIssueBodyMock.mockRejectedValueOnce(new Error('boom'));

    const ctx = await fetchPrReviewIssueContext('/repo/proj', 'owner/repo', 42);

    expect(ctx).toBeNull();
  });
});
