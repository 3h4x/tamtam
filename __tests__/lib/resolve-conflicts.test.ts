import { describe, it, expect, beforeEach, vi } from 'vitest';

// Unit tests for the resolve-conflicts harness. The safety-critical bit is
// finalizeResolveConflicts: it must ONLY force-push-with-lease after
// independently verifying (from git state, not the agent's word) that the tree
// is clean and the rebase completed — and must otherwise abort to a clean tree
// and re-raise the conflict HITL (merge-or-HITL invariant).

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveProjectPath: vi.fn(),
  launchPrWait: vi.fn(),
  appendRedactedFileSync: vi.fn(),
}));

vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));
vi.mock('@/lib/shared/project-data', () => ({ resolveProjectPath: mocks.resolveProjectPath }));
vi.mock('@/lib/pipeline/start-pr-wait', () => ({ launchPrWait: mocks.launchPrWait }));
vi.mock('@/lib/jobs/redacted-log-writer', () => ({ appendRedactedFileSync: mocks.appendRedactedFileSync }));

import {
  finalizeResolveConflicts,
  getPrForResolve,
  composeResolveConflictsPrompt,
  type PrForResolve,
  type ResolveConflictsMeta,
} from '@/lib/jobs/resolve-conflicts';
import type { JobData } from '@/lib/jobs/types';

function resp(exitCode: number, stdout = '', stderr = '') {
  return Promise.resolve({ exitCode, stdout, stderr });
}

const OPEN_PR_JSON = JSON.stringify({
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  mergeable: 'CONFLICTING',
  headRefName: 'fix/issue-1',
  baseRefName: 'main',
  headRepository: { name: 'r' },
  headRepositoryOwner: { login: 'o' },
});

const META: ResolveConflictsMeta = {
  prNumber: 42,
  prRepo: 'o/r',
  prUrl: 'https://github.com/o/r/pull/42',
  branch: 'fix/issue-1',
  defaultBranch: 'main',
};

function makeJob(meta: ResolveConflictsMeta | null): JobData {
  return {
    id: 'p-resolve-conflicts-1',
    project: 'p',
    kind: 'resolve-conflicts',
    logPath: '/tmp/rc.log',
    contextMeta: meta ? JSON.stringify(meta) : null,
    exitCode: 0,
    finishedAt: 1,
  } as unknown as JobData;
}

function pushCalls() {
  return (mocks.exec.mock.calls as [string, string[]][]).filter(
    ([c, a]) => c === 'git' && a.includes('push') && a.includes('--force-with-lease'),
  );
}
function abortCalls() {
  return (mocks.exec.mock.calls as [string, string[]][]).filter(
    ([c, a]) => c === 'git' && a.includes('rebase') && a.includes('--abort'),
  );
}

describe('finalizeResolveConflicts', () => {
  beforeEach(() => {
    mocks.exec.mockReset();
    mocks.resolveProjectPath.mockReset().mockReturnValue('/repo');
    mocks.launchPrWait.mockReset().mockReturnValue({ jobId: 'pw-1' });
    mocks.appendRedactedFileSync.mockReset();
  });

  // Route each exec by command so tests stay order-independent.
  function installExec(over: Partial<{
    prView: ReturnType<typeof resp>;
    branch: string;
    status: string;
    markers: number; // grep exit code (1 = no markers found)
    fetch: number;
    behind: string;
    ahead: string;
    push: number;
  }>) {
    mocks.exec.mockImplementation((cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(' ');
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return over.prView ?? resp(0, OPEN_PR_JSON);
      if (key.includes('branch --show-current')) return resp(0, `${over.branch ?? 'fix/issue-1'}\n`);
      if (key.includes('status --porcelain')) return resp(0, over.status ?? '');
      // git grep -l: exit 0 + file list when markers found; exit 1 + empty when none.
      if (key.includes('grep --cached')) return resp(over.markers ?? 1, over.markers === 0 ? 'src/server.js\n' : '');
      if (key.includes('fetch --quiet origin main')) return resp(over.fetch ?? 0, '');
      if (key.includes('rev-list --count HEAD..origin/main')) return resp(0, over.behind ?? '0');
      if (key.includes('rev-list --count origin/main..HEAD')) return resp(0, over.ahead ?? '2');
      if (key.includes('push --force-with-lease origin fix/issue-1')) return resp(over.push ?? 0, '');
      if (key.includes('rebase --abort')) return resp(0, '');
      throw new Error(`unexpected exec: ${key}`);
    });
  }

  it('force-pushes with lease and hands off to pr-wait on a verified clean rebase', async () => {
    installExec({ status: '', behind: '0', ahead: '2', push: 0 });
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(1);
    expect(abortCalls()).toHaveLength(0);
    expect(mocks.launchPrWait).toHaveBeenCalledWith('p', 42, 'o/r', 'https://github.com/o/r/pull/42');
  });

  it('never bare-force-pushes — only --force-with-lease', async () => {
    installExec({});
    await finalizeResolveConflicts(makeJob(META));
    const bareForce = (mocks.exec.mock.calls as [string, string[]][]).filter(
      ([c, a]) => c === 'git' && a.includes('push') && a.includes('--force') && !a.includes('--force-with-lease'),
    );
    expect(bareForce).toHaveLength(0);
  });

  it('aborts to a clean tree and re-raises the HITL when the worktree is not clean', async () => {
    installExec({ status: 'UU src/server.js\n' });
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(0);
    expect(abortCalls().length).toBeGreaterThanOrEqual(1);
    expect(mocks.launchPrWait).toHaveBeenCalledWith('p', 42, 'o/r', 'https://github.com/o/r/pull/42');
  });

  it('re-raises the HITL (no push) when the branch is still behind base after the agent', async () => {
    installExec({ status: '', behind: '3' });
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(0);
    expect(mocks.launchPrWait).toHaveBeenCalled();
  });

  it('re-raises the HITL when conflict markers remain in the resolved tree', async () => {
    installExec({ status: '', markers: 0 }); // grep exit 0 = markers found
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(0);
    expect(abortCalls().length).toBeGreaterThanOrEqual(1);
  });

  it('re-raises the HITL when the force-push is rejected by the lease', async () => {
    installExec({ status: '', behind: '0', ahead: '2', push: 1 });
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(1);
    // push failed → abort + re-raise
    expect(mocks.launchPrWait).toHaveBeenCalledWith('p', 42, 'o/r', 'https://github.com/o/r/pull/42');
  });

  it('does not push or nag when the PR is no longer open', async () => {
    installExec({ prView: resp(0, JSON.stringify({
      number: 42, url: 'https://github.com/o/r/pull/42', state: 'CLOSED', mergeable: 'CONFLICTING',
      headRefName: 'fix/issue-1', baseRefName: 'main', headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' },
    })) });
    await finalizeResolveConflicts(makeJob(META));
    expect(pushCalls()).toHaveLength(0);
    expect(mocks.launchPrWait).not.toHaveBeenCalled();
  });

  it('is a no-op when contextMeta is missing', async () => {
    await finalizeResolveConflicts(makeJob(null));
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.launchPrWait).not.toHaveBeenCalled();
  });
});

describe('getPrForResolve', () => {
  beforeEach(() => {
    mocks.exec.mockReset();
  });

  it('resolves an open PR head/base/repo from gh', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, OPEN_PR_JSON));
    const pr = await getPrForResolve('/repo', 42);
    expect(pr).toMatchObject({ number: 42, repo: 'o/r', branch: 'fix/issue-1', base: 'main', state: 'OPEN', mergeable: 'CONFLICTING' });
  });

  it('returns null when gh fails', async () => {
    mocks.exec.mockResolvedValueOnce(resp(1, '', 'gh boom'));
    expect(await getPrForResolve('/repo', 42)).toBeNull();
  });
});

describe('composeResolveConflictsPrompt', () => {
  it('instructs a rebase, forbids pushing, and wraps the diff as untrusted', () => {
    const pr: PrForResolve = {
      number: 42, repo: 'o/r', url: 'https://github.com/o/r/pull/42',
      branch: 'fix/issue-1', base: 'main', mergeable: 'CONFLICTING', state: 'OPEN',
    };
    const prompt = composeResolveConflictsPrompt(pr, 'src/server.js\nsrc/poller.js');
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toMatch(/do NOT run .{0,3}git push/i);
    expect(prompt).toContain('<untrusted');
    // withUntrustedPreamble prefix
    expect(prompt).toContain('SECURITY:');
    expect(prompt).toContain('src/server.js');
  });
});
