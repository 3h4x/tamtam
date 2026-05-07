import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { readLog } from '@/lib/jobs/verdict';
import { extractFindingIds } from '@/lib/pipeline/review-contract';
import type { JobData } from '@/lib/jobs/types';

export type ExhaustionReason = 'review-cap' | 'review-stuck' | 'fix-contradicts-review';

export type ExhaustionIssueResult =
  | { ok: true; issueNumber: number; issueUrl: string }
  | { ok: false; error: string };

const ISSUE_LABELS = ['tamtam', 'review-followup', 'priority-medium'];
const REVIEW_TAIL_BYTES = 3000;

type ExecLikeResult = Partial<{ stdout: string; stderr: string; exitCode: number }> | null | undefined;

function reasonHumanLabel(reason: ExhaustionReason): string {
  if (reason === 'review-cap') return 'review iteration cap reached';
  if (reason === 'review-stuck') return 'review findings stopped converging';
  return 'fixer claimed findings fixed but reviewer still flags them';
}

function shortReleaseId(releaseId: string | null | undefined): string {
  if (!releaseId) return 'standalone';
  // Job ids look like `<project>-release-<epochMicros>` — keep the last 8 of
  // the numeric tail for a short, human-friendly handle.
  const tail = releaseId.split('-').pop() ?? releaseId;
  return tail.slice(-8);
}

function buildIssueBody(opts: {
  reason: ExhaustionReason;
  reviewJob: JobData;
  findingIds: string[];
  reviewTail: string;
}): string {
  const { reason, reviewJob, findingIds, reviewTail } = opts;
  const findingsList = findingIds.length
    ? findingIds.map((id) => `- \`${id}\``).join('\n')
    : '- _(no Finding IDs were extracted from the review log; see the excerpt below for the raw findings)_';
  const releaseHandle = shortReleaseId(reviewJob.releaseId ?? null);
  return [
    `## Problem`,
    ``,
    `Release \`${releaseHandle}\` stopped before reaching LGTM: ${reasonHumanLabel(reason)}.`,
    `${findingIds.length} unresolved finding${findingIds.length === 1 ? '' : 's'} from review job \`${reviewJob.id}\` need follow-up. Check the release log for whether the partial work was ultimately committed or pushed after this fallback fired.`,
    ``,
    `## Approach`,
    ``,
    `Address each unresolved finding below, then run a fresh review:`,
    ``,
    findingsList,
    ``,
    `## Acceptance criteria`,
    ``,
    `- A new review on this branch returns \`Verdict: LGTM\``,
    `- None of the Finding IDs above appear in the new review log`,
    ``,
    `<details>`,
    `<summary>Original review excerpt</summary>`,
    ``,
    '```',
    reviewTail.trim(),
    '```',
    ``,
    `</details>`,
  ].join('\n');
}

function normalizeExecResult(result: ExecLikeResult) {
  return {
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 1,
  };
}

async function detectRepo(projPath: string): Promise<string | null> {
  // Let `gh` infer the repo from the project's git remote. Running `gh repo
  // view` inside the working tree resolves the upstream owner/repo without
  // needing a `-R` flag. (`-R .` is malformed: `-R` requires owner/repo, not
  // a path — that bug silently dropped the fallback to the legacy abort.)
  const raw = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: projPath,
    timeout: 10000,
  });
  const r = normalizeExecResult(raw);
  if (r.exitCode !== 0) return null;
  const owner = r.stdout.trim();
  return owner || null;
}

export async function fileReviewExhaustionIssue(
  reviewJob: JobData,
  reason: ExhaustionReason,
): Promise<ExhaustionIssueResult> {
  const projPath = resolveProjectPath(reviewJob.project);
  if (!projPath) return { ok: false, error: 'project path not found' };

  const repo = await detectRepo(projPath);
  if (!repo) return { ok: false, error: 'could not resolve GitHub repo for project' };

  const logText = readLog(reviewJob, 100_000);
  const findingIds = extractFindingIds(logText);
  const reviewTail = logText.slice(-REVIEW_TAIL_BYTES);

  const releaseHandle = shortReleaseId(reviewJob.releaseId ?? null);
  const title = `chore(review): finish review findings from release ${releaseHandle}`;
  const body = buildIssueBody({ reason, reviewJob, findingIds, reviewTail });

  const labelArgs: string[] = [];
  for (const l of ISSUE_LABELS) {
    labelArgs.push('--label', l);
  }

  const raw = await exec(
    'gh',
    ['-R', repo, 'issue', 'create', '--title', title, '--body', body, ...labelArgs],
    { cwd: projPath, timeout: 30000 },
  );
  const r = normalizeExecResult(raw);
  if (r.exitCode !== 0) {
    const detail = (r.stderr.trim() || r.stdout.trim() || `gh issue create exited ${r.exitCode}`).slice(0, 1000);
    return { ok: false, error: detail };
  }

  // gh issue create prints the URL on stdout. Parse number off the URL tail.
  const url = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const numberMatch = url.match(/\/issues\/(\d+)/);
  if (!numberMatch) {
    return { ok: false, error: `gh issue create returned unexpected output: ${url.slice(0, 200)}` };
  }
  return { ok: true, issueNumber: parseInt(numberMatch[1], 10), issueUrl: url };
}
