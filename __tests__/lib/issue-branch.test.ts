import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/scheduling/scheduling', () => ({
  getProjectTestConfig: vi.fn(async () => ({ issueAutoBranch: true })),
}));
vi.mock('@/lib/pipeline/pipeline-lock', () => ({ getLock: vi.fn(async () => null) }));
vi.mock('@/lib/jobs/job-storage', () => ({ listJobs: vi.fn(() => []) }));
vi.mock('@/lib/shared/project-data', () => ({ clearProjectDataCache: vi.fn() }));

import { ensureIssueBranch, issueBranchName } from '@/lib/github/issue-branch';

function resp(stdout = '', exitCode = 0) {
  return { stdout, stderr: exitCode === 0 ? '' : 'err', exitCode };
}

beforeEach(() => mocks.exec.mockReset());

describe('ensureIssueBranch — cuts the issue branch from fresh origin/<default>', () => {
  it('fetches origin and creates the branch from origin/<default> (not stale local HEAD)', async () => {
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(" ");
      if (a.includes('branch --show-current')) return resp('master');
      if (a.includes('symbolic-ref')) return resp('origin/master');
      if (a.includes('branch --merged')) return resp('');
      if (a.includes('fetch')) return resp('');
      if (a.includes('rev-parse --verify')) return resp('abc');
      if (a.includes('checkout -b')) return resp('Switched');
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 'Do a thing' });
    expect(r.status).toBe('created');
    const calls = mocks.exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('fetch --quiet origin master'))).toBe(true);
    expect(calls.find((c) => c.includes('checkout -b'))).toContain('origin/master');
  });

  it('falls back to a plain create from local HEAD when the origin-based checkout fails', async () => {
    let checkoutAttempts = 0;
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(" ");
      if (a.includes('branch --show-current')) return resp('master');
      if (a.includes('symbolic-ref')) return resp('origin/master');
      if (a.includes('branch --merged')) return resp('');
      if (a.includes('fetch')) return resp('');
      if (a.includes('rev-parse --verify')) return resp('abc');
      if (a.includes('checkout -b')) {
        checkoutAttempts++;
        return a.includes('origin/master') ? resp('', 1) : resp('Switched');
      }
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 't' });
    expect(r.status).toBe('created');
    expect(checkoutAttempts).toBe(2); // origin attempt failed → fell back to local HEAD
  });

  it('reuses an existing branch when both create attempts fail but checkout succeeds', async () => {
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(" ");
      if (a.includes('branch --show-current')) return resp('master');
      if (a.includes('symbolic-ref')) return resp('origin/master');
      if (a.includes('branch --merged')) return resp('');
      if (a.includes('fetch')) return resp('');
      if (a.includes('rev-parse --verify')) return resp('abc');
      if (a.includes('checkout -b')) return resp('', 1);
      if (a.includes('checkout fix/issue-90-t')) return resp('Switched');
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 't' });
    expect(r).toEqual({ status: 'reused', branch: 'fix/issue-90-t' });
  });

  it('returns an error when create and reuse checkouts all fail', async () => {
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(" ");
      if (a.includes('branch --show-current')) return resp('master');
      if (a.includes('symbolic-ref')) return resp('origin/master');
      if (a.includes('branch --merged')) return resp('');
      if (a.includes('fetch')) return resp('');
      if (a.includes('rev-parse --verify')) return resp('abc');
      if (a.includes('checkout')) return resp('', 1);
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 't' });
    expect(r.status).toBe('error');
    if (r.status !== 'error') throw new Error(`expected error, got ${r.status}`);
    expect(r.detail).toContain('Failed to checkout fix/issue-90-t');
  });

  it('is idempotent: already-on-branch when current branch is the issue branch', async () => {
    const branch = issueBranchName(90, 'Do a thing');
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(" ");
      if (a.includes('branch --show-current')) return resp(branch);
      if (a.includes('symbolic-ref')) return resp('origin/master');
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 'Do a thing' });
    expect(r.status).toBe('already-on-branch');
  });

  it('refuses to switch branches when the working tree is dirty (would carry stranded work across)', async () => {
    mocks.exec.mockImplementation(async (...call: unknown[]) => {
      const a = (Array.isArray(call[1]) ? (call[1] as string[]) : []).join(' ');
      if (a.includes('branch --show-current')) return resp('master'); // not on the issue branch
      if (a.includes('symbolic-ref')) return resp('origin/master');
      if (a.includes('status --porcelain')) return resp(' M lib/auth/token.ts\n?? app/api/auth/'); // dirty
      return resp('');
    });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 81, issueTitle: 'dry run' });
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toMatch(/uncommitted|stranded|dirty/i);
    const calls = mocks.exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('checkout -b'))).toBe(false); // never reached the checkout
  });

  it('skips when issue_auto_branch is disabled for the project', async () => {
    const { getProjectTestConfig } = await import('@/lib/scheduling/scheduling');
    (getProjectTestConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ issueAutoBranch: false });
    const r = await ensureIssueBranch({ projectName: 'p', projPath: '/p', issueNumber: 90, issueTitle: 't' });
    expect(r.status).toBe('skipped');
  });
});
