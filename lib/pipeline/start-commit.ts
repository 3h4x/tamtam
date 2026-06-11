import { mkdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { getSettings, getPipelineModel, getPermissionModeFlag } from '@/lib/shared/config';
import { getImproveConfig, setProjectPushResult } from '@/lib/scheduling/scheduling';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { isCliProvider } from '@/lib/usage/cli-providers';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { currentParent } from '@/lib/jobs/parent-context';
import { buildDiffContext } from '@/lib/git/diff-context';
import { createJob, markDone, updateJob, listJobs, findActiveReleaseJob } from '@/lib/jobs/job-storage';
import {
  finishJobCancellation,
  JobCancelledError,
  registerJobCancellation,
  throwIfJobCancelled,
} from '@/lib/jobs/cancellation';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import {
  findReleaseScopedIssueContext,
  issueStamped,
  type IssueContext,
} from './release-context';
import { appendRedactedFileSync } from '@/lib/jobs/redacted-log-writer';

export type CommitResult =
  | { ok: true; commitSha: string; message: string; jobId?: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

// Matches any conventional commit title with a non-trivial description (3+ chars).
const CONV_RE = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)(\(.+?\))?:\s*.{3,}/i;
// Generic fallback phrases the model produces when it lacks real diff context.
const GENERIC_RE = /^chore:\s*(automated?\s*update|update|changes?)$/i;

export async function generateCommitMessage(
  projPath: string,
  projectName: string,
  providerOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const [statR, diffR] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', '--cached', '--stat', '--no-color'], { timeout: 10000, signal }),
    exec('git', ['-C', projPath, 'diff', '--cached', '--no-color'], { timeout: 10000, signal }),
  ]);

  const { context } = buildDiffContext(statR.stdout, diffR.stdout);
  // Per-project .tamtam/config.yml `commit_style` overrides the global
  // `commit_style` setting. Lets repos pin their own voice without
  // affecting other projects.
  const { loadFileConfig } = await import('@/lib/skills/tamtam-file-config');
  const fileStyle = (loadFileConfig(projPath)?.commit_style ?? '').trim();
  const styleGuide = (fileStyle || (getSettings().commit_style ?? '')).trim();

  const buildPrompt = (extra = '') =>
    `Output exactly one conventional commit title. No prose, no code blocks, no backticks, no quotes.

Use the format: <type>(<optional scope>): <description>
Types: feat, fix, refactor, chore, docs, test, style, perf, ci, build

Analyze the diff to determine the correct type:
- feat: new capability or behavior added
- fix: corrects broken/incorrect behavior
- refactor: restructures code without changing behavior
- chore: tooling, config, dependencies, maintenance
- docs: documentation only
- test: adds or updates tests

Repository: ${projectName}
${context}
${styleGuide ? `\nSTYLE GUIDE:\n${styleGuide}\n` : ''}
Return ONLY the title — nothing else.${extra}`;

  const settings = getSettings();
  // generateCommitMessage is also called inline (not via job spawn), so it
  // accepts an explicit provider for inheritance; if absent, falls back to
  // the legacy claude_bin path so older direct callers keep working.
  const provider = isCliProvider(providerOverride) ? providerOverride : null;
  const claudeBin = provider
    ? resolveCliBin(provider, settings)
    : getImproveConfig().claudeBin;
  const cliEnv = provider
    ? resolveCliEnv(provider, settings)
    : {};

  // --system-prompt replaces the injected CLAUDE.md/git-history system prompt so the
  // model cannot pattern-match on recent "chore: automated update" commits.
  // --tools "" prevents the model from running git commands itself instead of using
  // the diff context we embed in the user prompt.
  const permissionArgs = getPermissionModeFlag().split(/\s+/).filter(Boolean);
  const claudeArgs = (prompt: string) => [
    '--print', ...permissionArgs, '--tools', '', '--system-prompt',
    'You are a commit message generator. Output only what is requested. Do not add prose or explanation.',
    '--model', getPipelineModel('commit'), '-p', prompt,
  ];

  const parse = (stdout: string): string => {
    const cleaned = stdout
      .trim()
      .split('\n')
      .map((l) => l.replace(/^[`'"*_\d.)\-•\s]+/, '').replace(/[`'"*_]+$/, '').trim())
      .filter(Boolean);
    // Prefer a specific conventional title; skip generic ones on first pass.
    return (
      cleaned.find((l) => CONV_RE.test(l) && !GENERIC_RE.test(l)) ??
      cleaned.find((l) => CONV_RE.test(l)) ??
      cleaned[0] ??
      ''
    );
  };

  const r1 = await exec(claudeBin, claudeArgs(buildPrompt()), { cwd: projPath, timeout: 30000, env: cliEnv, signal });
  const msg1 = parse(r1.stdout);

  // If the first attempt returns a generic placeholder, retry once with an explicit nudge.
  if (!msg1 || GENERIC_RE.test(msg1)) {
    const r2 = await exec(
      claudeBin,
      claudeArgs(buildPrompt('\n\nIMPORTANT: Be specific about what actually changed in the diff above. Do not use generic descriptions like "automated update".')),
      { cwd: projPath, timeout: 30000, env: cliEnv, signal },
    );
    const msg2 = parse(r2.stdout);
    if (msg2 && !GENERIC_RE.test(msg2)) return msg2;
  }

  // Both attempts were generic or empty — derive a specific fallback from the stat.
  if (!msg1 || GENERIC_RE.test(msg1)) {
    const fileNames = statR.stdout.trim().split('\n')
      .filter(l => l.includes('|'))
      .map(l => l.split('|')[0].trim())
      .filter(Boolean);
    if (fileNames.length > 0) {
      return `chore: update ${fileNames.slice(0, 3).join(', ')}`;
    }
  }

  return msg1 || 'chore: update files';
}

export function issueBranchName(issue: { number: number; title: string }): string {
  const slugTitle = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `fix/issue-${issue.number}${slugTitle ? `-${slugTitle}` : ''}`;
}

export async function deriveIssueContextFromBranch(
  projPath: string,
  signal?: AbortSignal,
): Promise<IssueContext | null> {
  const [branchR, repoR] = await Promise.all([
    exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal }),
    exec(
      'gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: projPath, timeout: 10000, signal },
    ),
  ]);
  if (branchR.exitCode !== 0) return null;
  const currentBranch = branchR.stdout.trim();
  const m = currentBranch.match(/^fix\/issue-(\d+)(?:-|$)/);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isFinite(number) || number <= 0) return null;

  const repo = repoR.exitCode === 0 ? repoR.stdout.trim() : '';
  if (!repo) return null;

  const issueR = await exec(
    'gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'title,state'],
    { cwd: projPath, timeout: 10000, signal },
  );
  if (issueR.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(issueR.stdout) as { title?: string; state?: string };
    const state = (parsed.state ?? '').toString().toUpperCase();
    if (state && state !== 'OPEN') return null;
    const title = (parsed.title ?? '').trim();
    if (!title) return null;
    return { number, repo, title };
  } catch {
    return null;
  }
}

export async function isIssueContextCompatibleWithCurrentBranch(
  issue: IssueContext,
  projPath: string,
): Promise<boolean> {
  let currentBranch = '';
  let mainBranch = '';
  try {
    const [branchR, detected] = await Promise.all([
      exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
      detectMainBranch(projPath),
    ]);
    currentBranch = branchR.stdout.trim();
    mainBranch = detected;
  } catch {
    // git unreachable — fall through with optimistic context.
  }

  if (currentBranch && mainBranch) {
    const inferredBranch = issueBranchName({ number: issue.number, title: issue.title });
    if (currentBranch !== mainBranch && currentBranch !== inferredBranch) {
      return false;
    }
  }

  return true;
}

export async function findIssueContext(
  projectName: string,
  projPath: string,
): Promise<IssueContext | null> {
  // Scope to the active release if there is one — a stale issue stamp from a
  // long-ago run must NOT decide what branch the current commit lands on.
  // Without this scope the most recent issue-tagged run job ever recorded
  // (no time bound) was treated as authoritative, which is how a `commit` on
  // master would decide to silently switch onto an unmerged `fix/issue-N-…`
  // branch from weeks ago.
  const active = findActiveReleaseJob(projectName);
  const candidates: IssueContext[] = [];
  const releaseIssue = active ? findReleaseScopedIssueContext(projectName, active) : null;
  if (releaseIssue) {
    candidates.push(releaseIssue);
  } else {
    const recentIssues = listJobs()
      .filter(
        j =>
          j.project === projectName &&
          j.kind === 'run' &&
          issueStamped(j) &&
          // No active release: only honor an issue stamp from a run started
          // in the last 30 minutes. Anything older was almost certainly a
          // different task.
          Date.now() / 1000 - j.startedAt < 30 * 60,
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const job of recentIssues) {
      if (!issueStamped(job)) continue;
      candidates.push({
        number: job.ghIssueNumber,
        repo: job.ghIssueRepo ?? '',
        title: job.ghIssueTitle ?? '',
      });
    }
  }
  if (candidates.length === 0) return null;

  for (const issue of candidates) {
    // If the working tree is currently checked out on a different feature
    // branch (not the default branch and not the inferred fix/issue-N branch),
    // trust the human's branch over the inferred issue context.
    if (!(await isIssueContextCompatibleWithCurrentBranch(issue, projPath))) {
      continue;
    }
    const repo = issue.repo;
    // Skip already-closed issues — otherwise the next release after an
    // issue-driven merge creates a redundant PR targeting the closed issue
    // (the run job keeps the gh_issue_number stamp forever).
    if (repo) {
      try {
        const r = await exec('gh', ['issue', 'view', String(issue.number), '--repo', repo, '--json', 'state'], { cwd: projPath, timeout: 10000 });
        if (r.exitCode === 0) {
          const state = (JSON.parse(r.stdout).state ?? '').toString().toUpperCase();
          if (state && state !== 'OPEN') continue;
        }
      } catch {
        // gh unreachable — fall through and use the context optimistically.
      }
    }
    return issue;
  }
  return null;
}

export async function detectMainBranch(projPath: string, signal?: AbortSignal): Promise<string> {
  const r = await exec('git', ['-C', projPath, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000, signal });
  if (r.exitCode === 0) {
    const match = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  // Fallback: check if 'main' or 'master' exists
  const mainR = await exec('git', ['-C', projPath, 'rev-parse', '--verify', 'main'], { timeout: 3000, signal });
  return mainR.exitCode === 0 ? 'main' : 'master';
}

// A `git` process that crashes or is SIGKILLed mid-write can leave
// `.git/index.lock` behind. git then refuses every subsequent `add`/`commit`
// until the file is removed. We only remove a lock after a conservative age
// threshold and a path-specific process check, because deleting a live lock
// defeats Git's index mutual exclusion.
const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

interface ClearStaleIndexLockOptions {
  nowMs?: number;
  staleMs?: number;
  isGitProcessActive?: (projPath: string, lockPath: string) => Promise<boolean>;
}

function shellQuoteForDisplay(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function processTableHasPotentialGitIndexOwner(psStdout: string, projPath: string, lockPath: string): boolean {
  const quotedPath = shellQuoteForDisplay(projPath);
  const quotedLock = shellQuoteForDisplay(lockPath);
  const hasExplicitOtherGitLocation = (cmd: string) =>
    /(?:^|\s)-C\s+/.test(cmd)
    || /(?:^|\s)--git-dir(?:=|\s+)/.test(cmd)
    || /(?:^|\s)--work-tree(?:=|\s+)/.test(cmd);
  const isIndexMutatingGitCommand = (cmd: string) =>
    /\bgit(\s|$)/.test(cmd)
    && /\b(add|commit|rm|mv|reset|checkout|switch|merge|rebase|cherry-pick|am|apply|stash|clean|restore)\b/.test(cmd);
  return psStdout
    .split('\n')
    .some((line) => {
      const cmd = line.trim();
      if (!/\bgit(\s|$)/.test(cmd)) return false;
      if (
        cmd.includes(projPath)
        || cmd.includes(quotedPath)
        || cmd.includes(lockPath)
        || cmd.includes(quotedLock)
      ) {
        return true;
      }
      // A live mutating `git` command can run from the repo cwd with no path
      // in argv. `ps` does not expose cwd, so preserve the lock only for
      // commands whose repository cannot be ruled out. Explicitly located
      // Git commands that do not mention this project are unrelated.
      return !hasExplicitOtherGitLocation(cmd) && isIndexMutatingGitCommand(cmd);
    });
}

async function isGitProcessActiveForPath(projPath: string, lockPath: string): Promise<boolean> {
  const ps = await exec('ps', ['-axo', 'pid=,command='], { timeout: 5000 });
  if (ps.exitCode !== 0) return true;
  return processTableHasPotentialGitIndexOwner(ps.stdout, projPath, lockPath);
}

export async function clearStaleIndexLock(
  projPath: string,
  log: (s: string) => void = () => {},
  options: ClearStaleIndexLockOptions = {},
): Promise<boolean> {
  try {
    const lockPath = join(/*turbopackIgnore: true*/ projPath, '.git', 'index.lock');
    const lockStat = statSync(/*turbopackIgnore: true*/ lockPath);
    const ageMs = (options.nowMs ?? Date.now()) - lockStat.mtimeMs;
    if (ageMs < (options.staleMs ?? STALE_INDEX_LOCK_MS)) return false;
    const isActive = await (options.isGitProcessActive ?? isGitProcessActiveForPath)(projPath, lockPath);
    if (isActive) {
      log(`\n# keeping old .git/index.lock (age ${Math.round(ageMs / 1000)}s — git process ownership not ruled out)\n`);
      return false;
    }
    rmSync(/*turbopackIgnore: true*/ lockPath, { force: true });
    log(`\n# removed stale .git/index.lock (age ${Math.round(ageMs / 1000)}s — no path-specific git process)\n`);
    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false;
    log(`\n# could not remove stale index.lock: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

function splitNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

function isTamtamCachePath(path: string): boolean {
  return path === '.tamtam/cache' || path.startsWith('.tamtam/cache/');
}

export async function stageProjectChanges(
  projPath: string,
  execStep: typeof exec,
  log: (s: string) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  log(`\n$ git add -u -- .\n`);
  const trackedR = await execStep('git', ['-C', projPath, 'add', '-u', '--', '.'], { timeout: 10000 });
  if (trackedR.stdout) log(trackedR.stdout);
  if (trackedR.stderr) log(trackedR.stderr);
  if (trackedR.exitCode !== 0) return trackedR;

  log(`\n$ git ls-files --others --exclude-standard -z\n`);
  const untrackedR = await execStep('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 10000 });
  if (untrackedR.stderr) log(untrackedR.stderr);
  if (untrackedR.exitCode !== 0) return untrackedR;

  const untracked = splitNulPaths(untrackedR.stdout).filter(path => !isTamtamCachePath(path));
  if (untracked.length === 0) return { exitCode: 0, stdout: '', stderr: '' };

  log(`\n$ git add -- ${untracked.map(p => JSON.stringify(p)).join(' ')}\n`);
  const addR = await execStep('git', ['-C', projPath, 'add', '--', ...untracked], { timeout: 10000 });
  if (addR.stdout) log(addR.stdout);
  if (addR.stderr) log(addR.stderr);
  return addR;
}

async function runCommit(
  projectName: string,
  projPath: string,
  log: (s: string) => void,
  issueCtx?: { number: number; repo: string; title: string } | null,
  provider?: string,
  job?: { id: string; abortedAt?: number | null; cancelRequestedExitCode?: number | null },
  signal?: AbortSignal,
): Promise<CommitResult> {
  const execStep = async (
    cmd: string,
    args: string[],
    options?: Parameters<typeof exec>[2],
  ) => {
    if (job) throwIfJobCancelled(job, signal);
    const result = await exec(cmd, args, {
      ...options,
      signal,
      abortProcessTree: cmd === 'git' ? true : options?.abortProcessTree,
    });
    if (job) throwIfJobCancelled(job, signal);
    return result;
  };

  // If we have issue context and are currently on the default branch, switch
  // to a feature branch BEFORE committing. Otherwise the commit lands on main,
  // the subsequent PR attempt produces an empty diff, and GH rejects it.
  if (issueCtx === undefined) issueCtx = await findIssueContext(projectName, projPath);

  if (issueCtx) {
    const [branchR, mainBranch] = await Promise.all([
      execStep('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 }),
      detectMainBranch(projPath, signal),
    ]);
    const currentBranch = branchR.stdout.trim();
    if (!currentBranch || currentBranch === mainBranch) {
      const featureBranch = issueBranchName(issueCtx);
      log(`\n# on ${currentBranch || '(detached)'} — switching to ${featureBranch} before commit\n`);
      const coR = await execStep('git', ['-C', projPath, 'checkout', '-b', featureBranch], { timeout: 10000 });
      if (coR.stdout) log(coR.stdout);
      if (coR.stderr) log(coR.stderr);
      if (coR.exitCode !== 0) {
        // Branch already exists locally. If it's already merged into the
        // default branch (zombie branch — PR merged, remote ref deleted, but
        // local ref still lingers), blow it away and create a fresh one.
        // Otherwise, try to reuse it by plain checkout.
        const mergedR = await execStep(
          'git', ['-C', projPath, 'branch', '--merged', mainBranch],
          { timeout: 5000 },
        );
        const mergedBranches = mergedR.stdout
          .split('\n')
          .map(l => l.replace(/^\*?\s+/, '').trim())
          .filter(Boolean);
        if (mergedBranches.includes(featureBranch)) {
          log(`# ${featureBranch} is already merged into ${mainBranch} — deleting zombie ref and recreating\n`);
          await execStep('git', ['-C', projPath, 'branch', '-D', featureBranch], { timeout: 5000 });
          const retryR = await execStep('git', ['-C', projPath, 'checkout', '-b', featureBranch], { timeout: 10000 });
          if (retryR.stdout) log(retryR.stdout);
          if (retryR.stderr) log(retryR.stderr);
          if (retryR.exitCode !== 0) {
            return { ok: false, status: 500, detail: `Failed to recreate feature branch ${featureBranch}: ${retryR.stderr || retryR.stdout}` };
          }
        } else {
          // Branch exists and is NOT merged. We do NOT auto-switch the default
          // branch's working tree onto an existing unmerged branch. `checkout
          // -m` would silently 3-way-merge the working tree with the branch
          // tip and can leave conflict markers in source files, which `git
          // add -A` would then stage into a broken commit. Refuse and let the
          // user resolve manually — switch + rebase, or delete/rename the
          // conflicting branch.
          const detail = `Refusing to auto-switch from ${currentBranch || '(detached)'} onto existing unmerged branch ${featureBranch}. ` +
            `Auto-switching from the default branch onto an existing branch is unsafe (silent merges can stage conflict markers). ` +
            `Either check out ${featureBranch} manually and resolve, or delete/rename it and retry.`;
          log(`# ${detail}\n`);
          return { ok: false, status: 409, detail };
        }
      }
    }
  }

  // Stage all changes including new (untracked) files. Keep TamTam's local
  // scratch cache out even if a project's ignore rule is missing or stale.
  //
  // Git staging can transiently fail when another git process holds
  // `.git/index.lock` (a prior step's pre-push hook, a concurrent
  // worktree status check, an IDE indexing pass). When that happens the
  // command exits non-zero and stages nothing — but the original code
  // ignored the exit and fell through to "Nothing to commit", pushing an
  // empty branch and surfacing "No commits between main and fix/*" at PR
  // creation. Retry on lock contention; fail-fast on any other non-zero
  // exit so the orchestrator records a real commit failure instead of
  // silently shipping nothing.
  // Remove a stale lock left by a previously crashed/killed git before staging,
  // so a single dead lock doesn't permanently brick this project's commits.
  await clearStaleIndexLock(projPath, log);
  let addR = await stageProjectChanges(projPath, execStep, log);
  if (addR.exitCode !== 0 && /index\.lock|unable to create.*lock/i.test(addR.stderr)) {
    for (let attempt = 1; attempt <= 6 && addR.exitCode !== 0; attempt++) {
      log(`\n# index.lock held by another git process — retry ${attempt}/6 in ${attempt}s\n`);
      await new Promise(r => setTimeout(r, attempt * 1000));
      // After waiting, retry the conservative stale-lock cleanup; it only
      // unlinks old locks that have no path-specific git process.
      await clearStaleIndexLock(projPath, log);
      addR = await stageProjectChanges(projPath, execStep, log);
    }
  }
  if (addR.exitCode !== 0) {
    const detail = (addR.stderr.trim() || addR.stdout.trim() || `git add exited ${addR.exitCode}`).slice(0, 2000);
    return { ok: false, status: 500, detail: `Stage failed: ${detail}` };
  }
  const statusR = await execStep('git', ['-C', projPath, 'diff', '--cached', '--name-status'], { timeout: 10000 });
  log(`\n$ git diff --cached --name-status\n${statusR.stdout}`);
  const hasStaged = !!statusR.stdout.trim();

  if (hasStaged) {
    log(`\n# generating commit message via Claude...\n`);
    const message = await generateCommitMessage(projPath, projectName, provider, signal);
    log(`# commit message: ${message}\n\n$ git commit -m "${message}"\n`);
    let commitR = await execStep('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
    if (commitR.stdout) log(commitR.stdout);
    if (commitR.stderr) log(commitR.stderr);
    // Pre-commit hook may have modified files, causing the commit to abort.
    // Stage the hook's changes and retry once so the hook's work is included.
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      const hookChangesR = await execStep('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000 });
      if (hookChangesR.stdout.trim()) {
        log(`\n# pre-commit hook modified files — staging and retrying commit\n`);
        const hookStageR = await stageProjectChanges(projPath, execStep, log);
        if (hookStageR.exitCode !== 0) {
          const detail = (hookStageR.stderr.trim() || hookStageR.stdout.trim() || `git add exited ${hookStageR.exitCode}`).slice(0, 2000);
          return { ok: false, status: 500, detail: `Stage failed after pre-commit hook changes: ${detail}` };
        }
        commitR = await execStep('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
        if (commitR.stdout) log(commitR.stdout);
        if (commitR.stderr) log(commitR.stderr);
      }
    }
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      const detail = (commitR.stderr.trim() || commitR.stdout.trim() || `git commit exited ${commitR.exitCode}`).slice(0, 2000);
      return { ok: false, status: 500, detail: `Commit failed: ${detail}` };
    }
    const shaR = await execStep('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
    return { ok: true, commitSha: shaR.exitCode === 0 ? shaR.stdout.trim() : '', message: 'committed' };
  } else {
    const aheadR = await execStep('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    log(`\n$ git rev-list --count @{u}..HEAD\n${aheadR.stdout}`);
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return { ok: true, commitSha: '', message: 'Nothing to commit' };
    }
    return { ok: true, commitSha: '', message: 'Nothing to commit (already ahead)' };
  }
}

async function recordDefaultDirtyCommitRecoveryMarker(
  projectName: string,
  projPath: string,
  commitJobId: string,
  log: (s: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const [branchR, mainBranch] = await Promise.all([
      exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000, signal }),
      detectMainBranch(projPath, signal),
    ]);
    if (branchR.exitCode !== 0) return;
    const currentBranch = branchR.stdout.trim();
    if (!currentBranch || currentBranch !== mainBranch) return;
    const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 5000, signal });
    if (statusR.exitCode !== 0 || !statusR.stdout.trim()) return;
    const { setDefaultDirtyCommitRecoveryMarker } = await import('./commit-recovery-marker');
    await setDefaultDirtyCommitRecoveryMarker(projectName, statusR.stdout, commitJobId);
    log('\n# recorded default-branch dirty recovery marker for failed commit\n');
  } catch (e) {
    log(`\n# could not record default-branch dirty recovery marker: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// One-line outcome for the commit job's History row title. runCommit returns a
// status-only `message` ('committed' / 'Nothing to commit'); read the actual
// subject from HEAD so the row reads like "fix(x): …  (abc1234)".
async function summarizeCommit(
  projPath: string,
  result: Extract<CommitResult, { ok: true }>,
  signal?: AbortSignal,
): Promise<string> {
  if (!result.commitSha) return result.message || 'Nothing to commit';
  try {
    const subjR = await exec('git', ['-C', projPath, 'log', '-1', '--format=%s'], { timeout: 5000, signal });
    const subject = subjR.exitCode === 0 ? subjR.stdout.trim() : '';
    return subject ? `${subject} (${result.commitSha})` : `Committed ${result.commitSha}`;
  } catch {
    return `Committed ${result.commitSha}`;
  }
}

export async function startProjectCommit(
  projectName: string,
  options: { parentJobId?: string | null } = {},
): Promise<CommitResult> {
  const parentJobId = options.parentJobId ?? currentParent();
  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = await isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = await getLock(projectName);
    if (lock) {
      setProjectPushResult(projectName, `Pipeline is running for ${projectName}`);
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    setProjectPushResult(projectName, 'project not found');
    return { ok: false, status: 404, detail: 'project not found' };
  }
  const gate = await checkCliStartGate('start a commit', { parentJobId });
  if (!gate.ok) {
    setProjectPushResult(projectName, gate.detail);
    return gate;
  }

  const { logDir } = getImproveConfig();
  mkdirSync(/*turbopackIgnore: true*/ logDir, { recursive: true });
  const provider = gate.provider;
  // Stamp issue context on the commit job so downstream hooks can pick it up.
  const earlyIssueCtx = await findIssueContext(projectName, projPath);
  const job = createJob(
    projectName, 'commit', process.pid, '',
    undefined, undefined, undefined,
    earlyIssueCtx?.number ?? null,
    earlyIssueCtx?.repo ?? null,
    earlyIssueCtx?.title ?? null,
    options.parentJobId,
  );
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;
  updateJob(job);
  const signal = registerJobCancellation(job.id);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-commit] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  const append = (s: string) => {
    try { appendRedactedFileSync(logPath, s); } catch {}
  };
  append(`# commit start — ${new Date().toISOString()}\n# repo: ${projPath}\n`);

  try {
    const result = await runCommit(projectName, projPath, append, earlyIssueCtx, provider, job, signal);
    try {
      setProjectPushResult(projectName, result.ok ? null : result.detail);
    } catch {}
    if (result.ok) {
      clearProjectDataCache();
      try {
        const { clearDefaultDirtyCommitRecoveryMarker } = await import('./commit-recovery-marker');
        await clearDefaultDirtyCommitRecoveryMarker(projectName);
      } catch {}
      // Record what the commit did so the History row's title shows the
      // outcome (commit subject + sha) instead of a generic "Commit" label.
      job.workSummary = await summarizeCommit(projPath, result, signal);
      append(`\n# commit ok — ${'commitSha' in result && result.commitSha ? result.commitSha : 'no-op'}\n${result.message}\n`);
    } else {
      append(`\n# commit failed (${result.status})\n${result.detail}\n`);
      await recordDefaultDirtyCommitRecoveryMarker(projectName, projPath, job.id, append, signal);
    }

    await markDone(job, result.ok ? 0 : 1);
    if (result.ok) return { ...result, jobId: job.id };
    return result;
  } catch (error) {
    if (!(error instanceof JobCancelledError)) throw error;
    append('\n# commit cancelled\n');
    const exitCode = job.cancelRequestedExitCode ?? -3;
    if (exitCode === -3 && job.abortedAt == null) job.abortedAt = Date.now() / 1000;
    await markDone(job, exitCode);
    return { ok: false, status: 499, detail: 'commit cancelled' };
  } finally {
    finishJobCancellation(job.id);
  }
}
