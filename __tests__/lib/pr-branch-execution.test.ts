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

  it('allows a non-default branch only when GitHub commit authors are trusted', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output('');
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

  it('does not trust spoofed local git author metadata', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output('');
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

  it('fails closed when GitHub cannot map a commit SHA to an author login', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output('');
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

  it('fails closed on non-default dirty tracked changes before GitHub author checks', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output(' M package.json\n');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('uncommitted or untracked changes'),
    }));
  });

  it('fails closed on non-default untracked files before GitHub author checks', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output('?? scripts/postinstall.js\n');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests');

    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('uncommitted or untracked changes'),
    }));
  });

  it('allowTrustedLocalChanges: permits uncommitted changes on a fresh branch (no commits ahead)', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output(' M docs/PIPELINE.md\n');
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests', { allowTrustedLocalChanges: true });
    expect(result).toEqual({ ok: true, reason: 'no_branch_commits' });
  });

  it('allowTrustedLocalChanges: STILL verifies committed branch commits against safe_users', () => {
    // The agent's branch was reused and carries an attacker commit ahead of base.
    // Allowing the uncommitted delta must NOT skip commit-author verification.
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') return output(' M docs/PIPELINE.md\n');
      if (key === 'git -C /repo rev-parse --verify origin/main') return output('origin/main\n');
      if (key === 'git -C /repo log --format=%H origin/main..HEAD') return output('deadbeef\n');
      if (key === 'gh repo view --json nameWithOwner --jq .nameWithOwner') return output('owner/repo\n');
      if (key === 'gh api repos/owner/repo/commits/deadbeef --jq .author.login') return output('attacker\n');
      throw new Error(`unexpected command: ${key}`);
    });
    mocks.isUserTrusted.mockImplementation((login: string) => login === 'trusted-user');

    const result = checkPrBranchExecutionGate('/repo', 'run tests', { allowTrustedLocalChanges: true });
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('GitHub author attacker'),
    }));
  });

  it('allowTrustedLocalChanges: still fails closed when git status itself cannot be read', () => {
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      const key = commandKey(command, args);
      if (key === 'git -C /repo status --porcelain --untracked-files=all') throw new Error('git boom');
      throw new Error(`unexpected command: ${key}`);
    });

    const result = checkPrBranchExecutionGate('/repo', 'run tests', { allowTrustedLocalChanges: true });
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      detail: expect.stringContaining('could not verify that the working tree matches'),
    }));
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
