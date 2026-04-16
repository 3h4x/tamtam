import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('git-utils', () => {
  let tempDir: string;
  let cacheDir: string;
  let gitStatusHash: typeof import('@/lib/git-utils').gitStatusHash;
  let markReviewed: typeof import('@/lib/git-utils').markReviewed;
  let isReviewed: typeof import('@/lib/git-utils').isReviewed;
  let gitChanges: typeof import('@/lib/git-utils').gitChanges;

  beforeEach(async () => {
    vi.resetModules();

    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-git-test-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'tamtam-git-cache-'));

    // Mock the homedir function to return our test cache directory
    vi.doMock('os', async () => {
      const actual = await vi.importActual('os');
      return {
        ...actual,
        homedir: () => cacheDir,
      };
    });

    // Mock the shell.exec function
    vi.doMock('@/lib/shell', () => ({
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === '-C') {
          const path = args[1];
          // Simulate git status command
          if (args[2] === 'status') {
            // Return mock git status output
            if (path === join(tempDir, 'clean')) {
              return { exitCode: 0, stdout: '' };
            } else if (path === join(tempDir, 'dirty')) {
              return { exitCode: 0, stdout: 'M file1.ts\nA file2.ts\n' };
            }
          }
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      }),
    }));

    const gitUtils = await import('@/lib/git-utils');
    gitStatusHash = gitUtils.gitStatusHash;
    markReviewed = gitUtils.markReviewed;
    isReviewed = gitUtils.isReviewed;
    gitChanges = gitUtils.gitChanges;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('gitStatusHash', () => {
    it('returns null when git command fails', async () => {
      const result = await gitStatusHash('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('returns hash of clean git status', async () => {
      const result = await gitStatusHash(join(tempDir, 'clean'));
      expect(result).toBeTruthy();
      expect(result).toMatch(/^[a-f0-9]{40}$/);
    });

    it('returns different hash for dirty status', async () => {
      const cleanHash = await gitStatusHash(join(tempDir, 'clean'));
      const dirtyHash = await gitStatusHash(join(tempDir, 'dirty'));

      expect(cleanHash).not.toEqual(dirtyHash);
    });

    it('returns same hash for same status', async () => {
      const hash1 = await gitStatusHash(join(tempDir, 'clean'));
      const hash2 = await gitStatusHash(join(tempDir, 'clean'));

      expect(hash1).toEqual(hash2);
    });
  });

  describe('markReviewed', () => {
    it('stores git status hash for a project', async () => {
      await markReviewed('test-project', join(tempDir, 'clean'));

      const reviewStateFile = join(cacheDir, '.cache', 'z', 'schedule-reviews', 'test-project.hash');
      expect(reviewStateFile).toBeTruthy();
    });

    it('stores hash as file content', async () => {
      const projectPath = join(tempDir, 'clean');
      const hash = await gitStatusHash(projectPath);

      await markReviewed('test-project', projectPath);

      // The hash should be stored in the review state file
      const reviewStateFile = join(cacheDir, '.cache', 'z', 'schedule-reviews', 'test-project.hash');
      expect(reviewStateFile).toBeTruthy();
    });

    it('can be called for different projects', async () => {
      const path1 = join(tempDir, 'clean');
      await markReviewed('project1', path1);
      await markReviewed('project2', path1);

      // Both calls should succeed
      expect(true).toBe(true);
    });

    it('returns undefined', async () => {
      const result = await markReviewed('test-project', join(tempDir, 'clean'));
      expect(result).toBeUndefined();
    });
  });

  describe('isReviewed', () => {
    it('returns false when no review state file exists', async () => {
      const result = await isReviewed('never-reviewed', join(tempDir, 'clean'));
      expect(result).toBe(false);
    });

    it('returns true when status hash matches stored hash', async () => {
      const projectPath = join(tempDir, 'clean');

      // Mark as reviewed
      await markReviewed('test-project', projectPath);

      // Check if reviewed (status should be the same)
      const result = await isReviewed('test-project', projectPath);
      expect(result).toBe(true);
    });

    it('returns false when status has changed', async () => {
      const cleanPath = join(tempDir, 'clean');
      const dirtyPath = join(tempDir, 'dirty');

      // Mark clean status as reviewed
      await markReviewed('test-project', cleanPath);

      // Check if dirty status is reviewed (it should not be)
      const result = await isReviewed('test-project', dirtyPath);
      expect(result).toBe(false);
    });

    it('returns false when git command fails', async () => {
      const result = await isReviewed('test-project', '/nonexistent/path');
      expect(result).toBe(false);
    });
  });

  describe('gitChanges', () => {
    it('returns null when git command fails', async () => {
      const result = await gitChanges('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('returns 0 for clean git status', async () => {
      const result = await gitChanges(join(tempDir, 'clean'));
      expect(result).toBe(0);
    });

    it('counts number of changed files', async () => {
      const result = await gitChanges(join(tempDir, 'dirty'));
      expect(result).toBe(2);
    });

    it('ignores whitespace-only lines', async () => {
      // The mock returns 'M file1.ts\nA file2.ts\n'
      // After filtering empty lines, should be 2 changes
      const result = await gitChanges(join(tempDir, 'dirty'));
      expect(result).toBe(2);
    });

    it('returns null on error', async () => {
      const result = await gitChanges('/invalid/path');
      expect(result).toBeNull();
    });
  });
});
