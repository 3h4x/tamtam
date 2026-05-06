import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getImproveConfig, getProjectTestConfig, getProjectPipelinePrompts } from '@/lib/scheduling/scheduling';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { checkCliStartGate } from '@/lib/usage/resolve-provider';
import { currentParent } from '@/lib/jobs/parent-context';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { createJob, listJobs, probeJobStatus, readParsedLog, updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { exec } from '@/lib/shared/shell';
import { getCurrentBranch, getReviewedRefSha, isAncestor, clearReviewedRef } from '@/lib/git/git-utils';
import { CODE_REVIEWER_SKILL } from '@/lib/skills/skills';
import { withBasePrompt, getPermissionModeFlag, getSettings, getPipelineModel } from '@/lib/shared/config';
import { getLock, acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { extractFindingIds, REVIEW_OUTPUT_CONTRACT, stripFinalVerdict } from './review-contract';
import type { JobData } from '@/lib/jobs/types';

export type StartReviewResult =
  | { ok: true; jobId: string; pid: number; logPath: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

function loadReviewPrompt(projectName: string): string {
  let content = '';
  if (existsSync(CODE_REVIEWER_SKILL)) {
    content = readFileSync(CODE_REVIEWER_SKILL, 'utf-8');
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3);
      if (end > 0) content = content.slice(end + 3).trimStart();
    }
  }
  const { review_verdict_rules } = getSettings();
  let reviewPromptAddendum: string | null = null;
  try {
    reviewPromptAddendum = getProjectPipelinePrompts(projectName).reviewPromptAddendum;
  } catch { /* test env without DB */ }
  const addendum = reviewPromptAddendum?.trim()
    ? '\n\n## Project-specific review guidance\n' + reviewPromptAddendum.trim()
    : '';
  return content +
    '\n\n---\n\n' +
    'Project: {project}\n' +
    'Path: {path}\n\n' +
    '{review_scope}\n\n' +
    '{release_context}\n\n' +
    REVIEW_OUTPUT_CONTRACT + '\n\n' +
    'OUTPUT FORMAT — strict. Your final non-empty line must be exactly one of:\n\n' +
    '    Verdict: LGTM\n' +
    '    Verdict: NEEDS ATTENTION\n' +
    '    Verdict: DO NOT SHIP\n\n' +
    'Rules:\n' +
    '- The verdict line MUST be the very last non-empty line of your response.\n' +
    '- No markdown decoration (no `**`, no `#`, no backticks, no bullet, no quote).\n' +
    '- No trailing punctuation, no rationale on the same line, no extra words.\n' +
    '- Put rationale BEFORE the verdict line, not after.\n\n' +
    'Example ending:\n\n' +
    '    The diff updates two helpers and adds matching tests. Tests pass.\n' +
    '\n    Verdict: LGTM\n\n' +
    'If you omit the verdict line, the release pipeline treats the review as ' +
    'NEEDS ATTENTION and runs a fix loop — wasted spend. Always emit one.\n\n' +
    review_verdict_rules +
    addendum;
}

type ReviewScope =
  | { ok: true; prompt: string }
  | { ok: false; detail: string };

async function determineReviewScope(projPath: string): Promise<ReviewScope> {
  const statusR = await exec('git', ['-C', projPath, 'status', '--porcelain', '--ignore-submodules'], { timeout: 5000 });
  const hasUncommittedChanges = statusR.exitCode === 0 && statusR.stdout.trim().length > 0;
  if (hasUncommittedChanges) {
    return {
      ok: true,
      prompt:
        'There are uncommitted changes in this repository. Use git and any other tools ' +
        'you need to inspect the changes yourself (git status, git diff, read files, ' +
        'etc.), then review them.',
    };
  }

  const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
  const ahead = parseInt(aheadR?.stdout?.trim() ?? '', 10);
  if (aheadR?.exitCode === 0 && Number.isFinite(ahead) && ahead > 0) {
    // Incremental review: narrow scope to commits since last LGTM if the
    // refs/tamtam/reviewed/<branch> ref still points at an ancestor of HEAD.
    // Falls back to @{u}..HEAD if the ref is missing, stale, or disabled.
    const incrementalEnabled = getSettings().incremental_review_enabled;
    if (incrementalEnabled) {
      const branch = await getCurrentBranch(projPath);
      if (branch) {
        const reviewedSha = await getReviewedRefSha(projPath, branch);
        if (reviewedSha) {
          const stillAncestor = await isAncestor(projPath, reviewedSha, 'HEAD');
          if (stillAncestor) {
            const narrowR = await exec('git', ['-C', projPath, 'rev-list', '--count', `${reviewedSha}..HEAD`], { timeout: 5000 });
            const narrowCount = parseInt(narrowR?.stdout?.trim() ?? '', 10);
            if (narrowR?.exitCode === 0 && Number.isFinite(narrowCount)) {
              if (narrowCount === 0) {
                // HEAD is exactly the reviewed commit — all unpushed commits are
                // already approved. Nothing new to review.
                return { ok: false, detail: 'All unpushed commits already approved (LGTM) — nothing new to review' };
              }
              const shortSha = reviewedSha.slice(0, 7);
              return {
                ok: true,
                prompt:
                  `The working tree is clean. ${ahead} local commit${ahead === 1 ? '' : 's'} are not yet pushed, but commits up to ${shortSha} were already approved (LGTM) in a previous review. ` +
                  `Review ONLY the ${narrowCount} new commit${narrowCount === 1 ? '' : 's'} since then. ` +
                  `Use \`git log --oneline ${shortSha}..HEAD\`, \`git diff --stat ${shortSha}..HEAD\`, and \`git diff ${shortSha}..HEAD\` — do not re-review code before ${shortSha}.`,
              };
            }
          } else {
            // Stale (rebase/reset past the marker) — clean it up so future
            // reviews don't keep paying the merge-base check.
            await clearReviewedRef(projPath, branch);
          }
        }
      }
    }
    return {
      ok: true,
      prompt:
        `The working tree is clean, but this branch has ${ahead} local commit${ahead === 1 ? '' : 's'} not yet pushed. ` +
        'Review the committed diff against upstream before it is pushed. Use git and any other tools you need, especially ' +
        '`git log --oneline @{u}..HEAD`, `git diff --stat @{u}..HEAD`, and `git diff @{u}..HEAD`, then review those changes.',
    };
  }

  return { ok: false, detail: 'No uncommitted changes or unpushed commits to review' };
}

function releaseContextForReview(projectName: string): string {
  const jobs = listJobs();
  const release = jobs
    .filter((j) => j.project === projectName && j.kind === 'release' && j.finishedAt === null)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (!release) {
    return 'PREVIOUS RELEASE REVIEW/FIX CONTEXT:\nNo active release context. Review the current uncommitted changes from first principles.';
  }

  const prior = jobs
    .filter((j) =>
      j.project === projectName &&
      j.releaseId === release.id &&
      (j.kind === 'review' || j.kind === 'fix') &&
      j.finishedAt !== null
    )
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

  if (prior.length === 0) {
    return `PREVIOUS RELEASE REVIEW/FIX CONTEXT:\nRelease ${release.id} has no previous review/fix iterations.`;
  }

  const blocks: string[] = [];
  for (const job of prior.slice(-6)) {
    blocks.push(describePriorReviewStep(job));
  }
  return `PREVIOUS RELEASE REVIEW/FIX CONTEXT:
Use this as review memory. First verify whether earlier findings were actually fixed, then search sibling paths before adding new findings.

${blocks.join('\n\n')}`;
}

function describePriorReviewStep(job: JobData): string {
  let log = '';
  try {
    log = stripFinalVerdict(readParsedLog(job)).trim();
  } catch {
    log = '';
  }
  const ids = log ? extractFindingIds(log) : [];
  const excerpt = log.length > 1800 ? `...(truncated)...\n${log.slice(-1800)}` : log;
  return `- ${job.kind} ${job.id} (${job.exitCode === 0 ? 'exit 0' : `exit ${job.exitCode ?? '?'}`}${ids.length ? `, findings ${ids.join(', ')}` : ''})
${excerpt || '(no log excerpt)'}`;
}

/** Start a code review for the given project. Returns the new job id or a structured error. */
export async function startProjectReview(
  projectName: string,
  options: { preferredProvider?: string | null } = {},
): Promise<StartReviewResult> {
  // Per-project off-switch — used when the agent prompt already performs review.
  try {
    if (getProjectTestConfig(projectName)?.reviewDisabled) {
      return { ok: false, status: 400, detail: `Review is disabled for ${projectName}` };
    }
  } catch { /* ignore — test env without DB */ }

  const { logDir } = getImproveConfig();
  const reviewModel = getPipelineModel('review');
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return { ok: false, status: 404, detail: `project '${projectName}' not found` };
  }
  const gate = await checkCliStartGate('start a review', {
    parentJobId: currentParent(),
    preferred: options.preferredProvider ?? null,
  });
  if (!gate.ok) return gate;
  const provider = gate.provider;
  const settings = getSettings();
  const claudeBin = resolveCliBin(provider, settings);
  const cliEnv = resolveCliEnv(provider, settings);

  // Check for existing pipeline lock — but allow running under a parent
  // release job's lock (this step was kicked off by the release pipeline).
  const underRelease = isLockOwnedByActiveRelease(projectName);
  if (!underRelease) {
    const lock = getLock(projectName);
    if (lock) {
      return { ok: false, status: 409, detail: `Pipeline is running for ${projectName}`, blockingJobId: lock.lockedByJobId };
    }
  }

  const jobs = listJobs();
  const running = jobs.filter(
    (j) => j.project === projectName && j.kind === 'review' && j.finishedAt === null
  );
  for (const j of running) {
    if ((await probeJobStatus(j)) === 'running') {
      return { ok: false, status: 409, detail: `Review already in progress for ${projectName} (PID ${j.pid})` };
    }
  }

  const scope = await determineReviewScope(projPath);
  if (!scope.ok) {
    return { ok: false, status: 400, detail: scope.detail };
  }

  const prompt = withBasePrompt(
    loadReviewPrompt(projectName)
      .replace('{project}', projectName)
      .replace('{path}', projPath)
      .replace('{review_scope}', scope.prompt)
      .replace('{release_context}', releaseContextForReview(projectName)),
    { projectPath: projPath, provider }
  );

  const job = createJob(projectName, 'review', 0, '');
  job.provider = provider;
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --verbose --include-partial-messages --model ${reviewModel} ${getPermissionModeFlag()}`,
      prompt,
      projPath,
      { env: cliEnv }
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 500, detail: `Failed to start review: ${msg}` };
  }

  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!underRelease) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-review] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}
