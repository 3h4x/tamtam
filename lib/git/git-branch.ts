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

// Per-process caches for the branch primitives. These are synchronous
// (`execFileSync`), so each runs to completion before the next caller starts on
// Node's single thread — a plain cache is therefore inherently single-flight and
// collapses the cold-load stampede where ~12 concurrent project-tab requests each
// re-spawned git (the dominant cause of 6–9s tab loads). Pinned to globalThis
// because Next.js duplicates modules across route-bundle realms.
//   - Default branch (origin/HEAD) does not change during a process lifetime →
//     cache it for the whole process.
//   - Current branch changes on checkout → short TTL so a branch switch is
//     reflected quickly; `clearBranchCache()` busts it immediately when a caller
//     knows it just switched.
declare global {
  var __tamtamDefaultBranchCache: Map<string, string> | undefined;
  var __tamtamCurrentBranchCache: Map<string, { branch: string; time: number }> | undefined;
}
const CURRENT_BRANCH_TTL_MS = 2000;
function defaultBranchCache(): Map<string, string> {
  return (globalThis.__tamtamDefaultBranchCache ??= new Map());
}
function currentBranchCache(): Map<string, { branch: string; time: number }> {
  return (globalThis.__tamtamCurrentBranchCache ??= new Map());
}

/** Bust the cached branch state for a path (call right after a checkout) — or
 *  the whole cache when no path is given. */
export function clearBranchCache(projectPath?: string): void {
  if (projectPath) {
    defaultBranchCache().delete(projectPath);
    currentBranchCache().delete(projectPath);
  } else {
    defaultBranchCache().clear();
    currentBranchCache().clear();
  }
}

/** Synchronously resolve origin's default branch (e.g. "main", "master"). */
export function getDefaultBranchSync(projectPath: string): string {
  const cache = defaultBranchCache();
  const hit = cache.get(projectPath);
  if (hit !== undefined) return hit;
  const value = computeDefaultBranchSync(projectPath);
  cache.set(projectPath, value);
  return value;
}

function computeDefaultBranchSync(projectPath: string): string {
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
  const cache = currentBranchCache();
  const hit = cache.get(projectPath);
  const now = Date.now();
  if (hit && now - hit.time < CURRENT_BRANCH_TTL_MS) return hit.branch;
  const branch = computeCurrentBranchSync(projectPath);
  cache.set(projectPath, { branch, time: now });
  return branch;
}

function computeCurrentBranchSync(projectPath: string): string {
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
