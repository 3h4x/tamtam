import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { getBranchContext } from '@/lib/git/git-branch';
import { isUserTrusted } from '@/lib/shared/untrusted';

const GIT_OPTS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 5000,
};

const RISKY_DIFF_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^bun\.lockb?$/,
  /^Cargo\.(toml|lock)$/,
  /^go\.(mod|sum)$/,
  /^requirements.*\.txt$/,
  /^pyproject\.toml$/,
  /^setup\.py$/,
  /^Makefile$/,
  /^makefile$/,
  /^GNUmakefile$/,
  /^Dockerfile$/,
  /^\.github\/workflows\//,
  /(^|\/)[^./]+\.config\.(js|cjs|mjs|ts|cts|mts)$/,
];

export type PrBranchExecutionGate =
  | { ok: true; reason: 'default_branch' | 'trusted_authors' | 'no_branch_commits' }
  | { ok: false; detail: string };

function git(projectPath: string, args: string[]): string {
  return execFileSync('git', ['-C', projectPath, ...args], GIT_OPTS).toString().trim();
}

function resolveBaseRef(projectPath: string, defaultBranch: string): string {
  try {
    git(projectPath, ['rev-parse', '--verify', `origin/${defaultBranch}`]);
    return `origin/${defaultBranch}`;
  } catch {
    return defaultBranch;
  }
}

function resolveGithubRepo(projectPath: string): string | null {
  try {
    const repo = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { ...GIT_OPTS, cwd: projectPath },
    ).toString().trim();
    return repo.includes('/') ? repo : null;
  } catch {
    return null;
  }
}

function worktreeStatus(projectPath: string): string | null {
  try {
    return git(projectPath, ['status', '--porcelain', '--untracked-files=all']);
  } catch {
    return null;
  }
}

function githubAuthorLoginForCommit(projectPath: string, repo: string, sha: string): string | null {
  try {
    const login = execFileSync(
      'gh',
      ['api', `repos/${repo}/commits/${sha}`, '--jq', '.author.login'],
      { ...GIT_OPTS, cwd: projectPath },
    ).toString().trim();
    if (!login || login === 'null') return null;
    return login;
  } catch {
    return null;
  }
}

export interface PrBranchExecutionGateOptions {
  // Set ONLY for releases whose working-tree delta was produced by TamTam's own
  // in-process agent run (issue-cruncher and friends). Those uncommitted
  // changes are as trusted as a run on the default branch — which the gate
  // already allows unconditionally — so this bypasses the uncommitted-changes
  // refusal while STILL verifying every committed branch commit against
  // safe_users (catching a reused branch carrying untrusted attacker commits).
  // It does NOT skip the gate; it narrows it to the same trust posture the
  // default branch already gets.
  allowTrustedLocalChanges?: boolean;
}

export function checkPrBranchExecutionGate(
  projectPath: string,
  actionLabel: string,
  options: PrBranchExecutionGateOptions = {},
): PrBranchExecutionGate {
  const branch = getBranchContext(projectPath);
  if (!branch.currentBranch) {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel}: could not determine the current branch for PR-branch execution verification. Approve the run explicitly or use an isolated runner.`,
    };
  }
  if (branch.isDefaultBranch) return { ok: true, reason: 'default_branch' };

  const status = worktreeStatus(projectPath);
  if (status == null) {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: could not verify that the working tree matches GitHub-verified commits. Approve the run explicitly or use an isolated runner.`,
    };
  }
  if (status.length > 0 && !options.allowTrustedLocalChanges) {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: working tree has uncommitted or untracked changes that cannot be verified through GitHub commit authors. Approve the run explicitly or use an isolated runner.`,
    };
  }

  const baseRef = resolveBaseRef(projectPath, branch.defaultBranch);
  let raw = '';
  try {
    raw = git(projectPath, ['log', '--format=%H', `${baseRef}..HEAD`]);
  } catch {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: could not list branch commits for GitHub author verification.`,
    };
  }

  const shas = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (shas.length === 0) return { ok: true, reason: 'no_branch_commits' };

  const repo = resolveGithubRepo(projectPath);
  if (!repo) {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: could not resolve GitHub repository for commit author verification. Approve the run explicitly or use an isolated runner.`,
    };
  }

  for (const sha of shas) {
    const login = githubAuthorLoginForCommit(projectPath, repo, sha);
    if (!login) {
      return {
        ok: false,
        detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: commit ${sha.slice(0, 12)} could not be mapped to a GitHub author. Approve the run explicitly or use an isolated runner.`,
      };
    }
    const trusted = isUserTrusted(login, projectPath);
    if (!trusted) {
      return {
        ok: false,
        detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: GitHub author ${login} for commit ${sha.slice(0, 12)} is not in safe_users / trusted_github_users. Approve the run explicitly or use an isolated runner.`,
      };
    }
  }

  return { ok: true, reason: 'trusted_authors' };
}

export function riskyPrDiffFiles(projectPath: string, prNumber: number, repo: string): string[] {
  let raw = '';
  try {
    raw = execFileSync(
      'gh',
      ['pr', 'diff', String(prNumber), '--repo', repo, '--name-only'],
      { ...GIT_OPTS, cwd: projectPath },
    ).toString().trim();
  } catch {
    return ['(unable to inspect PR diff)'];
  }
  return raw
    .split('\n')
    .map((file) => file.trim())
    .filter((file) => file && RISKY_DIFF_PATTERNS.some((pattern) => pattern.test(file)));
}
