import { execFileSync } from 'child_process';

/** Synchronously resolve origin's default branch (e.g. "main", "master"). */
export function getDefaultBranchSync(projectPath: string): string {
  try {
    const out = execFileSync('git', ['-C', projectPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    return out.trim().match(/refs\/remotes\/origin\/(.+)/)?.[1] ?? 'main';
  } catch {
    // Fallback: check if 'main' or 'master' ref exists
    try {
      execFileSync('git', ['-C', projectPath, 'rev-parse', '--verify', 'main'], {
        timeout: 3000,
        encoding: 'utf-8',
      });
      return 'main';
    } catch {
      return 'master';
    }
  }
}

/** Synchronously return the current branch name, or '' on failure. */
export function getCurrentBranchSync(projectPath: string): string {
  try {
    return execFileSync('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/** Read a file from a specific git ref. Returns null if the ref or path does not exist. */
export function gitShowSync(projectPath: string, ref: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['-C', projectPath, 'show', `${ref}:${relPath}`], {
      timeout: 5000,
      encoding: 'utf-8',
    });
  } catch {
    return null;
  }
}

/** List file names (not dirs) at a given tree path on a git ref. Returns [] on failure. */
export function gitLsTreeSync(projectPath: string, ref: string, treePath: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectPath, 'ls-tree', '--name-only', `${ref}:${treePath}`],
      { timeout: 5000, encoding: 'utf-8' }
    );
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface BranchContext {
  currentBranch: string;
  defaultBranch: string;
  isDefaultBranch: boolean;
}

/**
 * Returns branch context for a project path.
 * isDefaultBranch is true when the working tree is on the default branch
 * (or when branch detection fails, to fail open and avoid breaking existing behaviour).
 */
export function getBranchContext(projectPath: string): BranchContext {
  const defaultBranch = getDefaultBranchSync(projectPath);
  const currentBranch = getCurrentBranchSync(projectPath);
  return {
    currentBranch,
    defaultBranch,
    isDefaultBranch: !currentBranch || currentBranch === defaultBranch,
  };
}
