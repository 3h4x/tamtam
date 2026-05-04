import { join } from 'path';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { getImproveConfig } from '@/lib/scheduling/scheduling';
import { createJob, updateJob } from '@/lib/jobs/job-storage';
import { startJob } from '@/lib/jobs/pm2-jobs';
import { getPermissionModeFlag, getSettings } from '@/lib/shared/config';
import { errMsg } from '@/lib/shared/types';
import { acquireLock, isLockOwnedByActiveRelease } from './pipeline-lock';
import { runGates } from '@/lib/shared/job-control';

export type StartFixPushResult =
  | { ok: true; jobId: string; pid: number; logPath: string }
  | { ok: false; status: number; detail: string; blockingJobId?: string };

// Spawn a Claude job that reads the push-hook error and fixes the offending
// files. The completion hook then re-triggers startProjectPush once the fix
// finishes. Same pattern as fix-ci but scoped to pre-commit / pre-push hook
// failures so the release pipeline can self-heal instead of dead-ending on
// an ESLint nit.
export async function startFixPush(projectName: string, hookError: string): Promise<StartFixPushResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };
  const paused = runGates('start a fix-push job');
  if (paused) return paused;

  const { claudeBin, logDir } = getImproveConfig();
  const { default_model } = getSettings();
  let errorContext = hookError.trim();
  if (errorContext.length > 8000) errorContext = '...(truncated)...\n' + errorContext.slice(-8000);

  const prompt = `A git push for the \`${projectName}\` project just failed because the pre-commit or pre-push hook rejected the commit.

## Hook error

\`\`\`
${errorContext}
\`\`\`

Please:
1. Read the hook error carefully and locate the offending file(s) + line(s).
2. Fix the issue in the codebase. Small, surgical changes — don't refactor.
3. Run the relevant linter/type-check locally to confirm the fix works.
4. Do NOT commit — just make the code changes. The release pipeline will re-run the push automatically when you finish.
`;

  const job = createJob(projectName, 'fix-push', 0, '');
  const logPath = join(logDir, `${job.id}.log`);
  job.logPath = logPath;

  try {
    const pid = await startJob(
      job.id,
      `${claudeBin} --print --output-format stream-json --include-partial-messages --verbose --model ${default_model} ${getPermissionModeFlag()}`,
      prompt,
      projPath
    );
    job.pid = pid;
  } catch (e: unknown) {
    job.finishedAt = Date.now() / 1000;
    job.exitCode = -1;
    updateJob(job);
    return { ok: false, status: 500, detail: `Failed to start fix-push: ${errMsg(e)}` };
  }

  updateJob(job);

  // Acquire pipeline lock — skip under parent release lock.
  if (!isLockOwnedByActiveRelease(projectName)) {
    try {
      await acquireLock(projectName, job.id);
    } catch (e) {
      console.log(`[start-fix-push] failed to acquire pipeline lock for ${projectName}:`, e);
    }
  }

  return { ok: true, jobId: job.id, pid: job.pid, logPath };
}

// Signature-match: is this a hook-rejection error worth auto-fixing? Bails
// out on network/permission errors (those need human intervention).
export function isHookRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const s = detail.toLowerCase();
  return (
    s.includes('husky') ||
    s.includes('pre-commit') ||
    s.includes('pre-push') ||
    s.includes('lint-staged') ||
    /\beslint\b/.test(s) ||
    /@typescript-eslint/.test(s)
  );
}

// Detect when the hook rejection was caused by a test-framework failure
// (vitest/jest/mocha/pytest/etc.) rather than a lint/typecheck nit. fix-push
// is designed for surgical fixes Claude can apply to a known file+line; for
// test failures (especially flaky ones), letting it loop just burns attempts
// without converging. Caller skips fix-push when this returns true and lets
// the push fail loudly so a human can decide.
export function isTestFailureRejection(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const s = detail.toLowerCase();
  return (
    /\btests? failed\b/.test(s) ||
    /\btest files?\s+\d+\s+failed/.test(s) ||
    /\btests?\s+\d+\s+failed/.test(s) ||
    / fail\s+/.test(s) ||
    /❌\s*test/.test(s) ||
    /\bvitest\b.*\bfail/.test(s) ||
    /\bjest\b.*\bfail/.test(s) ||
    /test:integration\s+failed/.test(s) ||
    /test:unit\s+failed/.test(s) ||
    /test:e2e\s+failed/.test(s) ||
    /\bfailed:\s*test:/.test(s) ||
    /failing tests?:/.test(s)
  );
}
