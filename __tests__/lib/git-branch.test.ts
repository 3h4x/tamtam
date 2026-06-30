import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'child_process';
import {
  getDefaultBranchSync,
  getCurrentBranchSync,
  gitShowSync,
  gitLsTreeSync,
  getBranchContext,
  clearBranchCache,
} from '@/lib/git/git-branch';

const mockExec = vi.mocked(execFileSync);

describe('git-branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Branch primitives are now cached per process; reset between cases so each
    // test sees its own mocked git output rather than a prior case's cached value.
    clearBranchCache();
  });

  describe('getDefaultBranchSync', () => {
    it('parses branch name from symbolic-ref output', () => {
      mockExec.mockReturnValueOnce('refs/remotes/origin/main\n');
      expect(getDefaultBranchSync('/repo')).toBe('main');
    });

    it('returns "main" when symbolic-ref output does not match the expected pattern', () => {
      // symbolic-ref succeeds but output has no refs/remotes/origin/ prefix → ?? 'main'
      mockExec.mockReturnValueOnce('unexpected\n');
      expect(getDefaultBranchSync('/repo')).toBe('main');
    });

    it('falls back to "main" when symbolic-ref throws but main branch exists', () => {
      mockExec
        .mockImplementationOnce(() => { throw new Error('no origin/HEAD'); })
        .mockReturnValueOnce(''); // rev-parse --verify main succeeds
      expect(getDefaultBranchSync('/repo')).toBe('main');
    });

    it('falls back to "master" when both symbolic-ref and main branch check fail', () => {
      mockExec
        .mockImplementationOnce(() => { throw new Error('no origin/HEAD'); })
        .mockImplementationOnce(() => { throw new Error('no main branch'); });
      expect(getDefaultBranchSync('/repo')).toBe('master');
    });
  });

  describe('getCurrentBranchSync', () => {
    it('returns trimmed branch name', () => {
      mockExec.mockReturnValueOnce('feature/my-branch\n');
      expect(getCurrentBranchSync('/repo')).toBe('feature/my-branch');
    });

    it('returns empty string on failure', () => {
      mockExec.mockImplementationOnce(() => { throw new Error('not a git repo'); });
      expect(getCurrentBranchSync('/repo')).toBe('');
    });
  });

  describe('gitShowSync', () => {
    it('returns file content from the given ref', () => {
      mockExec.mockReturnValueOnce('config content here');
      expect(gitShowSync('/repo', 'main', '.tamtam/config.yml')).toBe('config content here');
    });

    it('returns null when the ref or path does not exist', () => {
      mockExec.mockImplementationOnce(() => { throw new Error('path not in tree'); });
      expect(gitShowSync('/repo', 'main', 'missing.txt')).toBeNull();
    });
  });

  describe('gitLsTreeSync', () => {
    it('returns list of file names at the given tree path', () => {
      mockExec.mockReturnValueOnce('agent1.md\nagent2.md\nreadme.txt\n');
      expect(gitLsTreeSync('/repo', 'main', '.tamtam/agents')).toEqual(['agent1.md', 'agent2.md', 'readme.txt']);
    });

    it('filters out empty lines', () => {
      mockExec.mockReturnValueOnce('a.md\n\nb.md\n');
      expect(gitLsTreeSync('/repo', 'main', '.tamtam/agents')).toEqual(['a.md', 'b.md']);
    });

    it('returns empty array on failure', () => {
      mockExec.mockImplementationOnce(() => { throw new Error('no such path'); });
      expect(gitLsTreeSync('/repo', 'main', '.tamtam/agents')).toEqual([]);
    });
  });

  describe('getBranchContext', () => {
    it('returns isDefaultBranch=true when on the default branch', () => {
      mockExec
        .mockReturnValueOnce('refs/remotes/origin/main\n') // getDefaultBranchSync
        .mockReturnValueOnce('main\n');                     // getCurrentBranchSync
      expect(getBranchContext('/repo')).toEqual({
        currentBranch: 'main',
        defaultBranch: 'main',
        isDefaultBranch: true,
      });
    });

    it('returns isDefaultBranch=false when on a feature branch', () => {
      mockExec
        .mockReturnValueOnce('refs/remotes/origin/main\n')
        .mockReturnValueOnce('feature/my-feature\n');
      expect(getBranchContext('/repo')).toEqual({
        currentBranch: 'feature/my-feature',
        defaultBranch: 'main',
        isDefaultBranch: false,
      });
    });

    it('returns isDefaultBranch=true (fail open) when branch detection fails', () => {
      // getDefaultBranchSync falls all the way back to "master";
      // getCurrentBranchSync throws → returns ''
      mockExec
        .mockImplementationOnce(() => { throw new Error(); }) // symbolic-ref fails
        .mockImplementationOnce(() => { throw new Error(); }) // rev-parse main fails → master
        .mockImplementationOnce(() => { throw new Error(); }); // getCurrentBranchSync fails
      const ctx = getBranchContext('/repo');
      expect(ctx.isDefaultBranch).toBe(true);
      expect(ctx.currentBranch).toBe('');
      expect(ctx.defaultBranch).toBe('master');
    });
  });

  describe('caching', () => {
    it('caches the default branch for the whole process (no repeat git spawn)', () => {
      mockExec.mockReturnValue(Buffer.from('refs/remotes/origin/main\n') as unknown as string);
      expect(getDefaultBranchSync('/repo')).toBe('main');
      const callsAfterFirst = mockExec.mock.calls.length;
      // Second + third calls must hit the cache — zero additional git spawns.
      expect(getDefaultBranchSync('/repo')).toBe('main');
      expect(getDefaultBranchSync('/repo')).toBe('main');
      expect(mockExec.mock.calls.length).toBe(callsAfterFirst);
    });

    it('caches the current branch within the TTL and re-resolves after clearBranchCache', () => {
      mockExec.mockReturnValue(Buffer.from('feature-x\n') as unknown as string);
      expect(getCurrentBranchSync('/repo')).toBe('feature-x');
      const afterFirst = mockExec.mock.calls.length;
      expect(getCurrentBranchSync('/repo')).toBe('feature-x'); // cached — no new spawn
      expect(mockExec.mock.calls.length).toBe(afterFirst);
      // After a checkout, the caller busts the cache → next read re-spawns git.
      clearBranchCache('/repo');
      mockExec.mockReturnValue(Buffer.from('main\n') as unknown as string);
      expect(getCurrentBranchSync('/repo')).toBe('main');
      expect(mockExec.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('caches per project path independently', () => {
      mockExec.mockReturnValue(Buffer.from('refs/remotes/origin/main\n') as unknown as string);
      getDefaultBranchSync('/repo-a');
      const afterA = mockExec.mock.calls.length;
      // A different path is a separate cache key → it must resolve afresh.
      getDefaultBranchSync('/repo-b');
      expect(mockExec.mock.calls.length).toBeGreaterThan(afterA);
    });
  });
});
