import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  getBranchContext: vi.fn(),
  isUserTrusted: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mocks.execFileSync(...args),
}));

vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: (...args: unknown[]) => mocks.getBranchContext(...args),
}));

vi.mock('@/lib/shared/untrusted', () => ({
  isUserTrusted: (...args: unknown[]) => mocks.isUserTrusted(...args),
}));

import { checkPrBranchExecutionGate, riskyPrDiffFiles } from '@/lib/security/pr-branch-execution';

function output(value: string): Buffer {
  return Buffer.from(value);
}

function commandKey(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

// Mimics `gh api repos/…/commits/<sha>` for a commit GitHub has never seen:
// exit 1 with the authoritative "No commit found for SHA" message on stderr
// (GitHub returns HTTP 422 for an unknown SHA, not 404).
function ghCommitAbsent(sha: string): never {
  const err = new Error('Command failed: gh api') as Error & { stderr: Buffer; status: number };
  err.stderr = Buffer.from(`gh: No commit found for SHA: ${sha} (HTTP 422)\n`);
  err.status = 1;
  throw err;
}

describe('checkPrBranchExecutionGate', () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.getBranchContext.mockReset().mockReturnValue({
      currentBranch: 'feature',
      defaultBranch: 'main',
      isDefaultBranch: false,
    });
    mocks.isUserTrusted.mockReset().mockReturnValue(false);
  });

  it('allows default branch execution without GitHub author checks', () => {
    mocks.getBranchContext.mockReturnValue({
      currentBranch: 'main',
      defaultBranch: 'main',
      isDefaultBranch: true,
    });

    expect(checkPrBranchExecutionGate('/repo', 'run tests')).toEqual({
      ok: true,
      reason: 'default_branch',
    });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('allows a non-default branch when GitHub commit authors are trusted', () => {
    // Note: no `git status` command is mocked — the gate must NOT consult the
    // working-tree state at all. If it did, the mock below throws on the
    // unexpected command and this test fails, guarding against a regression.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') return output('trusted-user\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    expect(checkPrBranchExecutionGate('/repo', 'run tests')).toEqual({
      ok: true,
      reason: 'trusted_authors',
    });
    expect(mocks.isUserTrusted).toHaveBeenCalledWith('trusted-user', '/repo');
  });

  it('runs even with a DIRTY working tree when committed authors are trusted', () => {
    // The exact real-world case: a trusted-authored feature branch carrying
    // uncommitted working-tree edits (agent/operator output). The uncommitted
    // delta is never externally-injected, so it must not block execution — only
    // the branch's committed history is verified.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') return output('trusted-user\n');
      // A `git status` call here would be a regression; leave it unmocked so it throws.
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    expect(checkPrBranchExecutionGate('/repo', 'run tests')).toEqual({
      ok: true,
      reason: 'trusted_authors',
    });
  });

  it('runs on a non-default branch with no commits ahead of base (dirty tree allowed)', () => {
    // A branch whose committed content equals the trusted base (nothing to
    // verify) with only local uncommitted edits on top — e.g. an
    // already-merged issue branch. This is the release that was wrongly blocked.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('');
      throw new Error(`unexpected command: ${key}`);
    });

    expect(checkPrBranchExecutionGate('/repo', 'run tests')).toEqual({
      ok: true,
      reason: 'no_branch_commits',
    });
    // Zero commits ahead means no author lookups are needed.
    expect(mocks.isUserTrusted).not.toHaveBeenCalled();
  });

  it('refuses a non-default branch carrying an untrusted committed author (even if tree is clean)', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') return output('attacker\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('GitHub author attacker'),
    }));
    expect(mocks.isUserTrusted).toHaveBeenCalledWith('attacker', '/repo');
    expect(mocks.isUserTrusted).not.toHaveBeenCalledWith('trusted-user', '/repo');
  });

  it('refuses an untrusted committed author even with a dirty working tree', () => {
    // A reused branch that carries an untrusted attacker commit must still be
    // refused; uncommitted local edits do not launder untrusted committed code.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('deadbeef\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/deadbeef --jq .author.login') return output('attacker\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    const result = checkPrBranchExecutionGate('/repo', 'run tests');
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('GitHub author attacker'),
    }));
  });

  it('does not trust spoofed local git author metadata (uses GitHub author.login only)', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') return output('attacker\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(mocks.isUserTrusted).toHaveBeenCalledWith('attacker', '/repo');
  });

  it('fails closed when GitHub cannot map a commit SHA to an author login', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') return output('null\n');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('could not be mapped to a GitHub author'),
    }));
    expect(mocks.isUserTrusted).not.toHaveBeenCalled();
  });

  it('runs a non-default branch whose only commit is local (never pushed to GitHub)', () => {
    // The real-world regression: the pipeline runs this gate at the FIRST step
    // (test), BEFORE the push phase, so a commit the operator/agent made locally
    // is not yet on GitHub. GitHub returns "No commit found for SHA" (HTTP 422).
    // That commit cannot be external PR code — external contributions arrive as
    // commits already on GitHub — so it is trusted local work and must run.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('localsha1\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/localsha1 --jq .author.login') ghCommitAbsent('localsha1');
      throw new Error(`unexpected command: ${key}`);
    });

    expect(checkPrBranchExecutionGate('/repo', 'run tests')).toEqual({
      ok: true,
      reason: 'trusted_authors',
    });
    // A never-pushed local commit needs no GitHub author trust lookup.
    expect(mocks.isUserTrusted).not.toHaveBeenCalled();
  });

  it('still refuses when a pushed untrusted commit sits under a local-only commit', () => {
    // A local commit on top of a pushed attacker commit must not launder the
    // attacker code: the pushed commit still resolves through GitHub and is
    // rejected. "Absent from GitHub" only excuses genuinely local commits.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('localsha\npushedbad\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/localsha --jq .author.login') ghCommitAbsent('localsha');
      if (key === 'gh api repos/owner/repo/commits/pushedbad --jq .author.login') return output('attacker\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    const result = checkPrBranchExecutionGate('/repo', 'run tests');
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('GitHub author attacker'),
    }));
  });

  it('fails closed when the author lookup fails transiently (not a missing-commit 422)', () => {
    // A network / auth / rate-limit failure is indeterminate — it must NOT be
    // mistaken for "commit absent from GitHub", or untrusted code could run
    // whenever GitHub is briefly unreachable. Only the exact missing-commit
    // signal is trusted; everything else fails closed.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/abc123 --jq .author.login') {
        const err = new Error('Command failed: gh api') as Error & { stderr: Buffer; status: number };
        err.stderr = Buffer.from('gh: Something went wrong (HTTP 500)\n');
        err.status = 1;
        throw err;
      }
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('author lookup failed'),
    }));
    expect(mocks.isUserTrusted).not.toHaveBeenCalled();
  });

  it('fails closed when the GitHub repository cannot be resolved', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('abc123\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') throw new Error('gh boom');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('could not resolve GitHub repository'),
    }));
  });

  it('fails closed when the branch commit list cannot be read', () => {
    // A broken repo where `git log base..HEAD` fails must refuse — the gate
    // cannot verify committed authorship, so it must not run project code.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') throw new Error('git boom');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('could not list branch commits'),
    }));
  });

  it('fails closed when branch detection fails instead of treating it as default branch', () => {
    mocks.getBranchContext.mockReturnValue({
      currentBranch: '',
      defaultBranch: 'main',
      isDefaultBranch: true,
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('could not determine the current branch'),
    }));
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});

describe('riskyPrDiffFiles', () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.getBranchContext.mockReset();
    mocks.isUserTrusted.mockReset();
  });

  it('inspects the actual GitHub PR diff, not the local checkout branch', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'gh pr diff 42 --repo owner/repo --name-only') {
        return output('README.md\npackage.json\nsrc/app.ts\n');
      }
      throw new Error(`unexpected command: ${key}`);
    });

    expect(riskyPrDiffFiles('/repo', 42, 'owner/repo')).toEqual(['package.json']);
    expect(mocks.getBranchContext).not.toHaveBeenCalled();
  });

  it('fails closed when the PR diff cannot be inspected', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('gh failed');
    });

    expect(riskyPrDiffFiles('/repo', 42, 'owner/repo')).toEqual(['(unable to inspect PR diff)']);
  });
});
