import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { readParsedLog } from '@/lib/jobs/verdict';
import { normalizeAcceptanceCriteria } from '@/lib/agents/issue-template';
import { parseFindings, type ParsedFinding, stripFinalVerdict } from '@/lib/pipeline/review-contract';
import type { JobData } from '@/lib/jobs/types';

export type ExhaustionIssueResult =
  | { ok: true; issueNumber: number; issueUrl: string }
  | { ok: false; error: string };

const ISSUE_LABELS = ['tamtam', 'review-followup', 'priority-medium'];
// Cap any free-form excerpt we keep in the issue body. Stream-json telemetry
// is parsed out before this is applied — the cap exists only to bound a
// pathological reviewer that ignored the structured contract.
const PROSE_FALLBACK_BYTES = 1200;

type ExecLikeResult = Partial<{ stdout: string; stderr: string; exitCode: number }> | null | undefined;

// Patterns that betray internal invocation details we never want to leak into a
// public GitHub issue. Full telemetry/launch lines are dropped; inline
// permission flags are removed so safe reviewer prose in the same field can
// still be carried into the follow-up issue.
const INVOCATION_LEAK_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*\[tamtam\]/i,
  /^\s*\{.*["']type["']\s*:\s*["'](stream_event|result|content_block_)/i,
];

const INVOCATION_LEAK_INLINE_PATTERNS: readonly RegExp[] = [
  /\s*--permission-mode(?:[=\s]+[^\s,;.)]+)?/gi,
  /\bbypassPermissions\b/gi,
  /\bdangerously[-_]?skip[-_]?permissions\b/gi,
];

function scrubInvocationLeaks(text: string): string {
  return text
    .split('\n')
    .filter((line) => !INVOCATION_LEAK_LINE_PATTERNS.some((re) => re.test(line)))
    .map((line) => INVOCATION_LEAK_INLINE_PATTERNS.reduce((acc, re) => acc.replace(re, ''), line).replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function renderFinding(f: ParsedFinding): string {
  const sev = f.severity ? ` _(severity: ${f.severity})_` : '';
  const rows: string[] = [`### \`${f.id}\`${sev}`];
  const rootCause = f.rootCause ? scrubInvocationLeaks(f.rootCause) : '';
  const affectedPaths = f.affectedPaths ? scrubInvocationLeaks(f.affectedPaths) : '';
  const requiredFix = f.requiredFix ? scrubInvocationLeaks(f.requiredFix) : '';
  const requiredTests = f.requiredTests ? scrubInvocationLeaks(f.requiredTests) : '';
  if (rootCause) rows.push(``, `**Root cause** — ${rootCause}`);
  if (affectedPaths) rows.push(``, `**Affected paths** — ${affectedPaths}`);
  if (requiredFix) rows.push(``, `**Required fix** — ${requiredFix}`);
  if (requiredTests) rows.push(``, `**Required tests** — ${requiredTests}`);
  return rows.join('\n');
}

// Severity rank for picking the headline finding. Higher = more important.
// Findings without a parsed severity sort last but keep their original parse order.
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function humanizeFindingId(id: string): string {
  return id.replace(/[-_/.]+/g, ' ').trim();
}

function buildIssueTitle(findings: ParsedFinding[]): string {
  if (findings.length === 0) return 'chore(review): unresolved review';
  const ranked = findings
    .map((f, i) => ({ f, i, rank: f.severity ? SEVERITY_RANK[f.severity] ?? 0 : 0 }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i);
  const top = humanizeFindingId(ranked[0].f.id);
  const extra = findings.length - 1;
  return extra > 0
    ? `chore(review): ${top} (+${extra} more)`
    : `chore(review): ${top}`;
}

function buildIssueBody(opts: {
  findings: ParsedFinding[];
  proseFallback: string;
}): string {
  const { findings, proseFallback } = opts;
  const findingCount = findings.length;
  const safeProse = scrubInvocationLeaks(proseFallback);
  const findingsBlock = findingCount > 0
    ? findings.map(renderFinding).join('\n\n')
    : safeProse
      ? '> ' + safeProse.split('\n').filter(Boolean).join('\n> ')
      : '_(no structured findings could be extracted from the review)_';
  return normalizeAcceptanceCriteria([
    `## Problem`,
    ``,
    findingsBlock,
    ``,
    `## Acceptance criteria`,
    ``,
    `- [ ] Each finding above is addressed in the implementation and covered by tests.`,
    `- [ ] A fresh review on this branch returns LGTM with no Finding IDs re-flagged.`,
  ].join('\n'));
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
): Promise<ExhaustionIssueResult> {
  const projPath = resolveProjectPath(reviewJob.project);
  if (!projPath) return { ok: false, error: 'project path not found' };

  const repo = await detectRepo(projPath);
  if (!repo) return { ok: false, error: 'could not resolve GitHub repo for project' };
  const repoLabels = await detectRepoLabels(projPath, repo);

  // Use the parsed (text-only) log so Finding IDs aren't trapped inside
  // stream-json string escapes. The raw log mixes the agent shim's
  // `[tamtam] launching:` lines and `{"type":"stream_event",...}` JSON, none
  // of which belongs in a public GitHub issue. The body deliberately omits
  // all invocation metadata — the issue is about the unresolved review
  // findings, not about how TamTam reached this state.
  const parsedLog = readParsedLog(reviewJob, 100_000);
  const findings = parseFindings(parsedLog);
  const proseOnly = stripFinalVerdict(parsedLog).trim();
  const proseFallback = proseOnly.length > PROSE_FALLBACK_BYTES
    ? `${proseOnly.slice(-PROSE_FALLBACK_BYTES).trim()} …`
    : proseOnly;

  const title = buildIssueTitle(findings);
  const body = buildIssueBody({ findings, proseFallback });

  // When the label-detection probe failed (null), fall back to NO labels
  // rather than the full ISSUE_LABELS list — `gh issue create --label X`
  // errors when `X` doesn't exist on the repo, so an unverified label set
  // would turn a single transient probe failure into a hard "could not
  // file follow-up issue" outcome. Filing the issue label-less still gets
  // the regression captured; operators can add labels manually.
  const labels = repoLabels ? ISSUE_LABELS.filter((label) => repoLabels.has(label)) : [];
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
