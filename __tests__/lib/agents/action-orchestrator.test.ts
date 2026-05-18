import { describe, it, expect, vi, beforeEach } from 'vitest';

// All helpers are mocked — this is a pure dispatcher unit test. The helpers
// themselves are exercised by the route regression tests + their original
// behavior coverage. We only verify orchestrator semantics: order, error
// aggregation, contextMeta-side logging.

vi.mock('@/lib/github/close-issue', () => ({
  closeIssue: vi.fn(),
}));
vi.mock('@/lib/github/comment-issue', () => ({
  commentIssue: vi.fn(),
}));
vi.mock('@/lib/github/label-issue', () => ({
  labelIssue: vi.fn(),
}));
vi.mock('@/lib/github/edit-issue-body', () => ({
  writeIssueBody: vi.fn(),
}));
vi.mock('@/lib/git/checkout-default', () => ({
  checkoutDefault: vi.fn(),
}));
vi.mock('@/lib/github/repo', () => ({
  resolveGhRepo: vi.fn().mockResolvedValue('owner/repo'),
}));

import { runAgentActions } from '@/lib/agents/action-orchestrator';
import { closeIssue } from '@/lib/github/close-issue';
import { commentIssue } from '@/lib/github/comment-issue';
import { labelIssue } from '@/lib/github/label-issue';
import { writeIssueBody } from '@/lib/github/edit-issue-body';
import { checkoutDefault } from '@/lib/git/checkout-default';

const baseInput = {
  project: 'demo',
  projPath: '/tmp/demo',
  jobId: 'demo-agent:issue-cruncher-1',
};

beforeEach(() => {
  vi.mocked(closeIssue).mockReset();
  vi.mocked(commentIssue).mockReset();
  vi.mocked(labelIssue).mockReset();
  vi.mocked(writeIssueBody).mockReset();
  vi.mocked(checkoutDefault).mockReset();
});

describe('runAgentActions', () => {
  it('dispatches a single issue-close action and reports executed=1', async () => {
    vi.mocked(closeIssue).mockResolvedValue({ ok: true, number: 10, reason: 'not planned', repo: 'owner/repo' });
    const result = await runAgentActions({
      ...baseInput,
      actions: [{ type: 'issue-close', number: 10, reason: 'not planned' }],
    });
    expect(result).toEqual({ executed: 1, errors: [] });
    expect(closeIssue).toHaveBeenCalledOnce();
    expect(closeIssue).toHaveBeenCalledWith(expect.objectContaining({
      project: 'demo',
      projPath: '/tmp/demo',
      number: 10,
      reason: 'not planned',
    }));
  });

  it('dispatches actions in declared order', async () => {
    const callOrder: string[] = [];
    vi.mocked(commentIssue).mockImplementation(async () => {
      callOrder.push('comment');
      return { ok: true, number: 1, repo: 'owner/repo' };
    });
    vi.mocked(closeIssue).mockImplementation(async () => {
      callOrder.push('close');
      return { ok: true, number: 1, reason: 'not planned', repo: 'owner/repo' };
    });
    vi.mocked(checkoutDefault).mockImplementation(async () => {
      callOrder.push('checkout');
      return { ok: true, status: 'switched', branch: 'main', deletedBranch: null };
    });

    const result = await runAgentActions({
      ...baseInput,
      actions: [
        { type: 'issue-comment', number: 1, body: 'first' },
        { type: 'issue-close', number: 1, reason: 'not planned' },
        { type: 'checkout-default' },
      ],
    });

    expect(result.executed).toBe(3);
    expect(result.errors).toEqual([]);
    expect(callOrder).toEqual(['comment', 'close', 'checkout']);
  });

  it('records per-action errors but does not abort the loop', async () => {
    vi.mocked(commentIssue).mockResolvedValue({ ok: false, status: 422, detail: 'comment fail' });
    vi.mocked(closeIssue).mockResolvedValue({ ok: true, number: 5, reason: 'not planned', repo: 'owner/repo' });

    const result = await runAgentActions({
      ...baseInput,
      actions: [
        { type: 'issue-comment', number: 5, body: 'x' },
        { type: 'issue-close', number: 5, reason: 'not planned' },
      ],
    });

    expect(result.executed).toBe(1);
    expect(result.errors).toEqual([
      { index: 0, type: 'issue-comment', detail: 'comment fail' },
    ]);
    expect(closeIssue).toHaveBeenCalledOnce();
  });

  it('captures thrown errors as per-action entries', async () => {
    vi.mocked(closeIssue).mockRejectedValue(new Error('boom'));
    vi.mocked(checkoutDefault).mockResolvedValue({ ok: true, status: 'switched', branch: 'main', deletedBranch: null });

    const result = await runAgentActions({
      ...baseInput,
      actions: [
        { type: 'issue-close', number: 1, reason: 'completed' },
        { type: 'checkout-default' },
      ],
    });

    expect(result.executed).toBe(1);
    expect(result.errors).toEqual([
      { index: 0, type: 'issue-close', detail: 'boom' },
    ]);
  });

  it('handles label add/remove default arrays', async () => {
    vi.mocked(labelIssue).mockResolvedValue({
      ok: true, number: 9, repo: 'owner/repo',
      addLabels: ['needs-info'], removeLabels: [],
    });

    const result = await runAgentActions({
      ...baseInput,
      actions: [
        { type: 'issue-label', number: 9, addLabels: ['needs-info'], removeLabels: [] },
      ],
    });

    expect(result.executed).toBe(1);
    expect(labelIssue).toHaveBeenCalledWith(expect.objectContaining({
      addLabels: ['needs-info'],
      removeLabels: [],
    }));
  });

  it('dispatches issue-edit-body via writeIssueBody with resolved repo', async () => {
    vi.mocked(writeIssueBody).mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    const result = await runAgentActions({
      ...baseInput,
      actions: [
        { type: 'issue-edit-body', kind: 'pr', number: 12, body: 'new body' },
      ],
    });

    expect(result.executed).toBe(1);
    expect(writeIssueBody).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo', kind: 'pr', number: 12, body: 'new body',
    }));
  });

  it('returns zero executed for an empty action list', async () => {
    const result = await runAgentActions({ ...baseInput, actions: [] });
    expect(result).toEqual({ executed: 0, errors: [] });
  });
});
