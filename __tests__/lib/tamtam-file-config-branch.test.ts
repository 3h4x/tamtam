import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock git-branch so we can simulate default vs feature branches without a real git repo.
vi.mock('@/lib/git/git-branch', () => ({
  getBranchContext: vi.fn(),
  gitShowSync: vi.fn(),
  gitLsTreeSync: vi.fn(),
  getDefaultBranchSync: vi.fn(),
  getCurrentBranchSync: vi.fn(),
}));

import * as gitBranch from '@/lib/git/git-branch';
import { loadFileConfig } from '@/lib/skills/tamtam-file-config';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tamtam-cfg-branch-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: string) {
  const cfgDir = join(dir, '.tamtam');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.yml'), content);
}

describe('loadFileConfig — branch-aware reading', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.resetAllMocks();
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reads from working tree when on the default branch', () => {
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: 'main',
      defaultBranch: 'main',
      isDefaultBranch: true,
    });
    writeConfig(tmpDir, 'test_command: pnpm test\n');
    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('pnpm test');
    // gitShowSync should NOT be called when on default branch
    expect(gitBranch.gitShowSync).not.toHaveBeenCalled();
  });

  it('reads from origin/<default> when on a feature branch', () => {
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: 'fix/issue-42',
      defaultBranch: 'main',
      isDefaultBranch: false,
    });
    vi.mocked(gitBranch.gitShowSync).mockReturnValue('test_command: npm test\nsecurity:\n  safe_users:\n    - owner\n');
    // Write a different config to the working tree — it should be ignored
    writeConfig(tmpDir, 'test_command: EVIL_COMMAND\nsecurity:\n  safe_users:\n    - attacker\n');

    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.test_command).toBe('npm test');
    expect(cfg?.safe_users).toEqual(['owner']);
    expect(gitBranch.gitShowSync).toHaveBeenCalledWith(tmpDir, 'origin/main', '.tamtam/config.yml');
  });

  it('returns null when origin/<default> has no .tamtam/config.yml (feature branch)', () => {
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: 'fix/issue-52',
      defaultBranch: 'main',
      isDefaultBranch: false,
    });
    vi.mocked(gitBranch.gitShowSync).mockReturnValue(null);
    // Feature branch has a config in its working tree — must be ignored
    writeConfig(tmpDir, 'auto_pr_merge_enabled: true\n');

    expect(loadFileConfig(tmpDir)).toBeNull();
  });

  it('ignores safe_users changes from a feature branch', () => {
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: 'feat/attacker',
      defaultBranch: 'main',
      isDefaultBranch: false,
    });
    // Default branch has safe_users: [owner]
    vi.mocked(gitBranch.gitShowSync).mockReturnValue(
      'security:\n  safe_users:\n    - owner\n'
    );
    // Feature branch tries to add attacker to safe_users — this is what we read from working tree
    // but the function should read from origin/main instead.
    writeConfig(tmpDir, 'security:\n  safe_users:\n    - owner\n    - attacker\n');

    const cfg = loadFileConfig(tmpDir);
    expect(cfg?.safe_users).toEqual(['owner']);
    expect(cfg?.safe_users).not.toContain('attacker');
  });

  it('reads test_command from origin/<default> on a feature branch, ignoring working-tree edits', () => {
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: 'feat/pr-abuse',
      defaultBranch: 'main',
      isDefaultBranch: false,
    });
    vi.mocked(gitBranch.gitShowSync).mockReturnValue('test_command: pnpm test\n');
    // Working-tree config tries to override test_command — must be ignored.
    writeConfig(tmpDir, 'test_command: rm -rf /\n');

    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm test');
  });

  it('fails open (reads working tree) when git-branch returns isDefaultBranch: true due to detection failure', () => {
    // Simulate a non-git directory: getBranchContext fails open
    vi.mocked(gitBranch.getBranchContext).mockReturnValue({
      currentBranch: '',
      defaultBranch: 'main',
      isDefaultBranch: true, // fail-open: treat as default branch
    });
    writeConfig(tmpDir, 'test_command: pnpm test\n');
    expect(loadFileConfig(tmpDir)?.test_command).toBe('pnpm test');
    expect(gitBranch.gitShowSync).not.toHaveBeenCalled();
  });
});
