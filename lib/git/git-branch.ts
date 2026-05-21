import { execFileSync, ExecFileSyncOptions } from 'child_process';

// All helpers in this file model "succeed or fall back" — we never want git's
// stderr to leak to our parent stderr (which PM2 captures into the tamtam
// log and Loki ingests as ERROR). `stdio: ['ignore', 'pipe', 'ignore']`
// keeps stdout for parsing and silences stderr. Without this, normal
// fallback paths (e.g. a repo without origin/HEAD set as a symref, or no
// `main` branch) generate spurious `fatal: ...` errors in /monitoring.
const SILENT: ExecFileSyncOptions = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
};

/** Synchronously resolve origin's default branch (e.g. "main", "master"). */
export function getDefaultBranchSync(projectPath: string): string {
  try {
    const out = execFileSync('git', ['-C', projectPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      ...SILENT,
      timeout: 5000,
    });
    return out.toString().trim().match(/refs\/remotes\/origin\/(.+)/)?.[1] ?? 'main';
  } catch {
    // Fallback: check if 'main' or 'master' ref exists
    try {
      execFileSync('git', ['-C', projectPath, 'rev-parse', '--verify', 'main'], {
        ...SILENT,
        timeout: 3000,
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
      ...SILENT,
      timeout: 5000,
    }).toString().trim();
  } catch {
    return '';
  }
}

/** Read a file from a specific git ref. Returns null if the ref or path does not exist. */
export function gitShowSync(projectPath: string, ref: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['-C', projectPath, 'show', `${ref}:${relPath}`], {
      ...SILENT,
      timeout: 5000,
    }).toString();
  } catch {
    return null;
  }
}

/**
 * List entry names (files AND subdirs) at a given tree path on a git ref.
 * Returns [] on failure. Callers that need files-only must filter further;
 * `gitShowSync` returns null for tree entries, so the typical pattern is
 * "list names, attempt to show each, skip nulls".
 */
export function gitLsTreeSync(projectPath: string, ref: string, treePath: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectPath, 'ls-tree', '--name-only', `${ref}:${treePath}`],
      { ...SILENT, timeout: 5000 }
    );
    return out.toString().split('\n').map(l => l.trim()).filter(Boolean);
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
