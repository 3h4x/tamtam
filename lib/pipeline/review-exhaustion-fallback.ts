import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { readParsedLog } from '@/lib/jobs/verdict';
import { parseFindings, type ParsedFinding, stripFinalVerdict } from '@/lib/pipeline/review-contract';
import type { JobData } from '@/lib/jobs/types';

export type ExhaustionReason = 'review-cap' | 'review-stuck' | 'fix-contradicts-review';

export type ExhaustionIssueResult =
  | { ok: true; issueNumber: number; issueUrl: string }
  | { ok: false; error: string };

const ISSUE_LABELS = ['tamtam', 'review-followup', 'priority-medium'];
// Cap any free-form excerpt we keep in the issue body. Stream-json telemetry
// is parsed out before this is applied — the cap exists only to bound a
// pathological reviewer that ignored the structured contract.
const PROSE_FALLBACK_BYTES = 1200;

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

function renderFinding(f: ParsedFinding): string {
  const sev = f.severity ? ` _(severity: ${f.severity})_` : '';
  const rows: string[] = [`### \`${f.id}\`${sev}`];
  if (f.rootCause) rows.push(``, `**Root cause** — ${f.rootCause}`);
  if (f.affectedPaths) rows.push(``, `**Affected paths** — ${f.affectedPaths}`);
  if (f.requiredFix) rows.push(``, `**Required fix** — ${f.requiredFix}`);
  if (f.requiredTests) rows.push(``, `**Required tests** — ${f.requiredTests}`);
  return rows.join('\n');
}

function buildIssueBody(opts: {
  reason: ExhaustionReason;
  reviewJob: JobData;
  findings: ParsedFinding[];
  proseFallback: string;
}): string {
  const { reason, reviewJob, findings, proseFallback } = opts;
  const releaseHandle = shortReleaseId(reviewJob.releaseId ?? null);
  const findingCount = findings.length;
  const findingsBlock = findingCount > 0
    ? findings.map(renderFinding).join('\n\n')
    : `_The reviewer did not produce structured Finding blocks. Raw note from the review:_\n\n${proseFallback ? '> ' + proseFallback.split('\n').filter(Boolean).join('\n> ') : '_(empty)_'}`;
  const ids = findings.map((f) => `\`${f.id}\``).join(', ') || '_none extracted_';
  return [
    `## Problem`,
    ``,
    `Release \`${releaseHandle}\` stopped before reaching LGTM: ${reasonHumanLabel(reason)}.`,
    `${findingCount} unresolved finding${findingCount === 1 ? '' : 's'} carried over from TamTam review job \`${reviewJob.id}\`.`,
    ``,
    `## Approach`,
    ``,
    findingsBlock,
    ``,
    `## Acceptance criteria`,
    ``,
    `- Each finding above is addressed in the implementation and covered by tests.`,
    `- A fresh review on this branch returns \`Verdict: LGTM\` with none of the Finding IDs above (${ids}) re-flagged.`,
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

async function detectRepoLabels(projPath: string, repo: string): Promise<Set<string> | null> {
  const raw = await exec('gh', ['-R', repo, 'label', 'list', '--limit', '1000', '--json', 'name'], {
    cwd: projPath,
    timeout: 10000,
  });
  const r = normalizeExecResult(raw);
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim()) as Array<{ name?: unknown }>;
    const labels = parsed
      .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
      .filter((name): name is string => name.length > 0);
    return new Set(labels);
  } catch {
    return null;
  }
}

export async function fileReviewExhaustionIssue(
  reviewJob: JobData,
  reason: ExhaustionReason,
): Promise<ExhaustionIssueResult> {
  const projPath = resolveProjectPath(reviewJob.project);
  if (!projPath) return { ok: false, error: 'project path not found' };

  const repo = await detectRepo(projPath);
  if (!repo) return { ok: false, error: 'could not resolve GitHub repo for project' };
  const repoLabels = await detectRepoLabels(projPath, repo);

  // Use the parsed (text-only) log so Finding IDs aren't trapped inside
  // stream-json string escapes. The raw log mixes the agent shim's
  // `[tamtam] launching:` lines and `{"type":"stream_event",...}` JSON, none
  // of which belongs in a public GitHub issue.
  const parsedLog = readParsedLog(reviewJob, 100_000);
  const findings = parseFindings(parsedLog);
  const proseOnly = stripFinalVerdict(parsedLog).trim();
  const proseFallback = proseOnly.length > PROSE_FALLBACK_BYTES
    ? `${proseOnly.slice(-PROSE_FALLBACK_BYTES).trim()} …`
    : proseOnly;

  const releaseHandle = shortReleaseId(reviewJob.releaseId ?? null);
  const title = findings.length > 0
    ? `chore(review): ${findings.length} unresolved finding${findings.length === 1 ? '' : 's'} from release ${releaseHandle}`
    : `chore(review): unresolved review from release ${releaseHandle}`;
  const body = buildIssueBody({ reason, reviewJob, findings, proseFallback });

  const labels = repoLabels ? ISSUE_LABELS.filter((label) => repoLabels.has(label)) : ISSUE_LABELS;
  const labelArgs: string[] = [];
  for (const l of labels) {
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
