import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { homedir } from 'os';
import { getBranchContext } from '@/lib/git/git-branch';
import { isUserTrusted } from '@/lib/shared/untrusted';

// Pin HOME so git and gh resolve their user config even when the server
// process was launched with a stripped env (e.g. a PM2 daemon started without
// HOME). git needs it to read repo/user config for `git log`, and gh needs it
// for its auth/hosts config when resolving commit authors through the API.
const GIT_OPTS: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  timeout: 5000,
  env: { ...process.env, HOME: process.env.HOME || homedir() },
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

// The outcome of resolving one branch commit to a GitHub author:
//   - `login`   → GitHub knows the commit and mapped it to an account login.
//   - `absent`  → GitHub has never seen the commit (it was never pushed), so it
//                 is local operator/agent work — trusted, see the gate comment.
//   - `noAuthor`→ GitHub has the commit but could not map it to an account.
//   - `failed`  → the lookup itself failed (network / auth / rate-limit); the
//                 result is indeterminate and must fail closed.
type CommitAuthorResult =
  | { kind: 'login'; login: string }
  | { kind: 'absent' }
  | { kind: 'noAuthor' }
  | { kind: 'failed' };

// GitHub answers `GET /repos/{repo}/commits/{sha}` for a SHA it does not have
// with HTTP 422 "No commit found for SHA: …". That message is the authoritative
// signal that a commit was never pushed and exists only in the local clone. It
// is matched narrowly — NOT on any 4xx — so an auth/rate-limit/network failure
// still fails closed instead of laundering untrusted code as "local".
const COMMIT_ABSENT_FROM_GITHUB = /no commit found for sha/i;

function commandStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString();
    if (typeof stderr === 'string') return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

function resolveCommitAuthor(projectPath: string, repo: string, sha: string): CommitAuthorResult {
  try {
    // stderr is piped (GIT_OPTS discards it) so the missing-commit signal below
    // can be distinguished from a transient failure.
    const login = execFileSync(
      'gh',
      ['api', `repos/${repo}/commits/${sha}`, '--jq', '.author.login'],
      { ...GIT_OPTS, cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
    if (!login || login === 'null') return { kind: 'noAuthor' };
    return { kind: 'login', login };
  } catch (err) {
    if (COMMIT_ABSENT_FROM_GITHUB.test(commandStderr(err))) return { kind: 'absent' };
    return { kind: 'failed' };
  }
}

// Guards host-side execution of project code (test / review-prerequisite /
// dev-server commands) on a non-default branch.
//
// The one external-code vector this gate exists to stop is a branch whose
// COMMITS were pulled in by checking out someone's PR head — those commits
// would execute during `pnpm test` et al. So the gate resolves every commit the
// branch adds over the trusted base to a GitHub `author.login` and refuses
// unless all of them are trusted (or the branch adds no commits at all).
//
// A commit GitHub has never seen (never pushed) is NOT external code: external
// contributions always arrive as commits already present on GitHub — a PR head,
// which this same API resolves to the contributor's login. A commit that only
// exists in the local clone can only be the operator's or TamTam's own agent
// output, so it carries the same trust the working tree is granted (below), and
// is allowed to run. This matters because the pipeline runs this gate at its
// FIRST step (test), before the push phase — so freshly-made local commits are
// routinely not yet on GitHub, and failing them closed wrongly blocked every
// such release.
//
// It also deliberately does NOT gate on the working tree being clean.
// Uncommitted working-tree changes can only be the operator's or TamTam's own
// agent output — nothing external can write them (an external PR arrives as
// commits, which are verified above) — so they carry the same trust the default
// branch is granted unconditionally. Refusing on a dirty tree only ever produced
// false positives against legitimate local work; the committed-author check is
// the real boundary and is preserved intact.
export function checkPrBranchExecutionGate(
  projectPath: string,
  actionLabel: string,
): PrBranchExecutionGate {
  const branch = getBranchContext(projectPath);
  if (!branch.currentBranch) {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel}: could not determine the current branch for PR-branch execution verification. Approve the run explicitly or use an isolated runner.`,
    };
  }
  if (branch.isDefaultBranch) return { ok: true, reason: 'default_branch' };

  const baseRef = resolveBaseRef(projectPath, branch.defaultBranch);
  let raw = '';
  try {
    raw = git(projectPath, ['log', '--format=%H', `${baseRef}..HEAD`]);
  } catch {
    return {
      ok: false,
      detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: could not list branch commits for GitHub author verification. Approve the run explicitly or use an isolated runner.`,
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
    const author = resolveCommitAuthor(projectPath, repo, sha);

    // Never pushed to GitHub → local operator/agent work → trusted (see above).
    if (author.kind === 'absent') continue;

    if (author.kind === 'noAuthor') {
      return {
        ok: false,
        detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: commit ${sha.slice(0, 12)} could not be mapped to a GitHub author. Approve the run explicitly or use an isolated runner.`,
      };
    }

    if (author.kind === 'failed') {
      return {
        ok: false,
        detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: GitHub author lookup failed for commit ${sha.slice(0, 12)}. Approve the run explicitly or use an isolated runner.`,
      };
    }

    if (!isUserTrusted(author.login, projectPath)) {
      return {
        ok: false,
        detail: `Refusing to ${actionLabel} on non-default branch ${branch.currentBranch}: GitHub author ${author.login} for commit ${sha.slice(0, 12)} is not in safe_users / trusted_github_users. Approve the run explicitly or use an isolated runner.`,
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
