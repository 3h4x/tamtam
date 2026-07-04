import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { resolveProjectPath, clearProjectDataCache } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { getSettings } from '@/lib/shared/config';
import { db, schema } from '@/lib/db';
import { homedir } from 'os';
import { isUserTrusted } from '@/lib/shared/untrusted';
import { ensureIssueBranch, checkoutPrBranch, issueBranchName } from '@/lib/github/issue-branch';
import { findOpenPrForIssue, type IssuePrMatch } from '@/lib/github/find-issue-pr';
import { listJobs } from '@/lib/jobs/job-storage';
import { resolvePrWaitHitlForMergedPr } from '@/lib/jobs/resolve-pr-wait-hitl';
import { friendlyMergeError, isChecksPendingError } from '@/lib/github/merge-error';
import {
  parseLinkedIssue,
  computeDodFromBody,
  computePrGates,
  issueHasContext,
  type PrGates,
} from '@/lib/github/issue-row-enrichment';

const CACHE_TTL_S = 300; // 5 minutes

function filterTrustedIssues(issues: unknown[], projectPath: string): unknown[] {
  return issues.filter((issue) => {
    if (!issue || typeof issue !== 'object') return false;
    const author = (issue as { author?: { login?: unknown } }).author;
    if (!author || typeof author.login !== 'string') return false;
    return isUserTrusted(author.login, projectPath);
  });
}

function slimLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: unknown) => (l && typeof l === 'object' ? String((l as Record<string, unknown>).name ?? '') : String(l)));
}

function slimAuthor(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const login = (raw as Record<string, unknown>).login;
  return typeof login === 'string' ? login : null;
}

function slimIssue(issue: unknown): unknown {
  if (!issue || typeof issue !== 'object') return issue;
  const o = issue as Record<string, unknown>;
  return { number: o.number, title: o.title, labels: slimLabels(o.labels), author: slimAuthor(o.author), url: o.url, hasContext: o.hasContext === true };
}

function slimPR(pr: unknown): unknown {
  if (!pr || typeof pr !== 'object') return pr;
  const o = pr as Record<string, unknown>;
  return { number: o.number, title: o.title, labels: slimLabels(o.labels), author: slimAuthor(o.author), url: o.url, branch: o.headRefName, isDraft: o.isDraft, gates: o.gates ?? null };
}

// Fold per-row context/gate data into the issue and PR objects in a single
// pass over the in-memory jobs cache. This replaces the per-row
// `continue-issue` / `pr-gates` request fan-out (one HTTP call per open issue
// and PR) that made the Issues tab fire 40+ requests on every open.
function enrichRows(
  projectName: string,
  issues: unknown[],
  prs: unknown[],
): { issues: unknown[]; prs: unknown[] } {
  const projectJobs = listJobs().filter((j) => j.project === projectName);
  const bodyByNumber = new Map<number, string>();
  for (const i of issues) {
    if (!i || typeof i !== 'object') continue;
    const o = i as Record<string, unknown>;
    if (typeof o.number === 'number') bodyByNumber.set(o.number, typeof o.body === 'string' ? o.body : '');
  }

  const enrichedIssues = issues.map((i) => {
    if (!i || typeof i !== 'object') return i;
    const o = i as Record<string, unknown>;
    const num = typeof o.number === 'number' ? o.number : Number(o.number);
    return { ...o, hasContext: Number.isFinite(num) ? issueHasContext(projectJobs, num) : false };
  });

  const enrichedPrs = prs.map((pr) => {
    if (!pr || typeof pr !== 'object') return pr;
    const o = pr as Record<string, unknown>;
    const issueNumber = parseLinkedIssue(typeof o.body === 'string' ? o.body : null);
    // DoD comes from the linked issue's body, which the issue-list fetch
    // already returns — no per-PR `gh issue view` round-trip. A PR linked to
    // an issue outside the open set (e.g. already closed) has no local body,
    // so its DoD reads as none.
    const dod = computeDodFromBody(issueNumber != null ? bodyByNumber.get(issueNumber) ?? null : null);
    const gates: PrGates = computePrGates(projectJobs, issueNumber, dod);
    return { ...o, gates };
  });

  return { issues: enrichedIssues, prs: enrichedPrs };
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    const message = (current as { message?: unknown }).message;
    const detail = (current as { detail?: unknown }).detail;
    const query = (current as { query?: unknown }).query;
    const text = [code, message, detail, query, String(current)]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');

    if (text.includes(relationName) && (text.includes('does not exist') || text.includes('42P01'))) {
      return true;
    }

    const cause = (current as { cause?: unknown }).cause;
    if (cause) stack.push(cause);
  }

  return false;
}

// Labels that signal the issue is not ready for an autonomous code change.
// The picker excludes these so the issue picker doesn't keep choosing the same
// non-actionable issue every cron cycle and creating empty fix branches the
// reconciler then has to clean up.
const BLOCKER_LABELS = new Set([
  'blocked', 'needs-info', 'needs-design', 'needs-refinement',
  'discussion', 'question', 'wontfix', 'duplicate', 'human-needed',
]);

const PRIORITY_TIERS: Array<{ score: number; labels: ReadonlySet<string> }> = [
  { score: 100, labels: new Set(['critical', 'priority:critical', 'urgent', 'priority:urgent', 'p0']) },
  { score: 75, labels: new Set(['high', 'priority:high', 'p1']) },
  { score: 50, labels: new Set(['bug']) },
  { score: 25, labels: new Set(['enhancement', 'feature', 'priority:medium', 'p2']) },
];
const BONUS_LABELS = new Set(['good first issue']);

function rankIssueScore(labels: string[]): number {
  const lower = labels.map((l) => l.toLowerCase());
  let score = 10;
  for (const tier of PRIORITY_TIERS) {
    if (lower.some((l) => tier.labels.has(l))) {
      score = tier.score;
      break;
    }
  }
  if (lower.some((l) => BONUS_LABELS.has(l))) score += 5;
  return score;
}

function isAssignedToOther(issue: Record<string, unknown>): boolean {
  const assignees = issue.assignees;
  return Array.isArray(assignees) && assignees.length > 0;
}

function pickEligibleIssue(issues: unknown[], projectPath: string): Record<string, unknown> | null {
  const ranked: Array<{ issue: Record<string, unknown>; score: number; updatedAt: string }> = [];
  for (const i of issues) {
    if (!i || typeof i !== 'object') continue;
    const obj = i as Record<string, unknown>;
    const author = (obj.author as { login?: unknown } | undefined)?.login;
    if (typeof author !== 'string' || !isUserTrusted(author, projectPath)) continue;
    const labels = slimLabels(obj.labels);
    if (labels.some((l) => BLOCKER_LABELS.has(l.toLowerCase()))) continue;
    if (isAssignedToOther(obj)) continue;
    const score = rankIssueScore(labels);
    const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';
    ranked.push({ issue: obj, score, updatedAt });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return ranked[0].issue;
}

type CommentInput = { author?: { login?: unknown } | null; createdAt?: unknown; body?: unknown };
type TrustedComment = { author: string | null; createdAt: string; body: string };

function filterTrustedComments(
  rawComments: unknown,
  projectPath: string,
): { kept: TrustedComment[]; droppedCount: number } {
  if (!Array.isArray(rawComments)) return { kept: [], droppedCount: 0 };
  const kept: TrustedComment[] = [];
  let droppedCount = 0;
  for (const raw of rawComments) {
    if (!raw || typeof raw !== 'object') {
      droppedCount += 1;
      continue;
    }
    const c = raw as CommentInput;
    const login = c.author?.login;
    if (typeof login !== 'string' || !isUserTrusted(login, projectPath)) {
      droppedCount += 1;
      continue;
    }
    kept.push({
      author: login,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      body: typeof c.body === 'string' ? c.body : '',
    });
  }
  return { kept, droppedCount };
}

function revalidateCachedIssuePayload(
  payload: PickTopResponse['issue'],
  projectPath: string,
): PickTopResponse['issue'] | null {
  if (!payload) return null;
  if (!payload.author || !isUserTrusted(payload.author, projectPath)) return null;
  const { kept, droppedCount } = filterTrustedComments(
    payload.comments.map((comment) => ({
      author: { login: comment.author },
      createdAt: comment.createdAt,
      body: comment.body,
    })),
    projectPath,
  );
  return {
    ...payload,
    comments: kept,
    droppedCommentCount: payload.droppedCommentCount + droppedCount,
  };
}

async function getGhRepo(projectName: string, projPath: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', projPath, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    if (r.exitCode === 0) {
      let url = r.stdout.trim();
      if (url.startsWith('git@github.com:')) url = url.slice('git@github.com:'.length);
      else if (url.startsWith('https://github.com/')) url = url.slice('https://github.com/'.length);
      url = url.replace(/\.git$/, '');
      if (url && url.includes('/')) return url;
    }
  } catch {}
  const { github_owner: dbGithubOwner } = getSettings();
  const owner = process.env.GITHUB_OWNER || dbGithubOwner || projectName;
  return `${owner}/${projectName}`;
}

type EnsuredList = {
  repo: string;
  prs: unknown[];
  issues: unknown[];
  fetchedAt: number;
  cached: boolean;
  ghError: string | null;
};

async function ensureIssueList(
  projectName: string,
  projPath: string,
  forceRefresh: boolean,
): Promise<EnsuredList | { detail: string; status: number }> {
  if (!forceRefresh) {
    const cached = (await db
      .select()
      .from(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .limit(1))[0] ?? null;
    if (cached && Date.now() / 1000 - cached.fetchedAt < CACHE_TTL_S) {
      return {
        repo: cached.repo,
        prs: JSON.parse(cached.prs),
        issues: JSON.parse(cached.issues),
        fetchedAt: cached.fetchedAt,
        cached: true,
        ghError: null,
      };
    }
  }

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return { detail: 'could not determine GitHub repo', status: 422 };

  const prFields = 'number,title,state,author,url,createdAt,updatedAt,headRefName,baseRefName,isDraft,reviewDecision,labels,body,statusCheckRollup';
  const issueFields = 'number,title,state,author,url,createdAt,updatedAt,assignees,labels,body';

  const [prsResult, issuesResult] = await Promise.all([
    exec('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', prFields, '--limit', '50'], { timeout: 15000 }),
    exec('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--json', issueFields, '--limit', '50'], { timeout: 15000 }),
  ]);

  let prs: unknown[] = [];
  let issues: unknown[] = [];

  if (prsResult.exitCode === 0 && prsResult.stdout.trim()) {
    try { prs = JSON.parse(prsResult.stdout); } catch {}
  }
  if (issuesResult.exitCode === 0 && issuesResult.stdout.trim()) {
    try { issues = JSON.parse(issuesResult.stdout); } catch {}
  }

  const ghError = prsResult.exitCode !== 0
    ? prsResult.stderr.trim() || 'gh pr list failed'
    : issuesResult.exitCode !== 0
    ? issuesResult.stderr.trim() || 'gh issue list failed'
    : null;

  const fetchedAt = Date.now() / 1000;

  if (!ghError) {
    await db.insert(schema.ghIssuesCache)
      .values({ project: projectName, repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt })
      .onConflictDoUpdate({
        target: schema.ghIssuesCache.project,
        set: { repo, prs: JSON.stringify(prs), issues: JSON.stringify(issues), fetchedAt },
      })
      .execute();
  }

  return { repo, prs, issues, fetchedAt, cached: false, ghError };
}

type PickTopResponse = {
  chosenIssue: number | null;
  issue: {
    number: number;
    title: string;
    author: string;
    state: string;
    labels: string[];
    url: string;
    body: string;
    comments: Array<{ author: string | null; createdAt: string; body: string }>;
    droppedCommentCount: number;
  } | null;
  branch: { name: string; status: 'created' | 'reused' | 'already-on-branch' | 'skipped' } | null;
  // When an OPEN PR already implements the chosen issue, TamTam checks out that
  // PR's branch (instead of a fresh fix branch) and surfaces it here so the
  // issue-cruncher verifies-and-merges the existing work instead of redoing it.
  openPr?: { number: number; branch: string; url: string } | null;
  reason: string | null;
  cached: boolean;
  cachedAt: number;
};

async function checkoutForPickTop(
  projectName: string,
  projPath: string,
  chosenNumber: number,
  title: string,
): Promise<{ ok: true; branch: PickTopResponse['branch']; openPr?: IssuePrMatch | null } | { ok: false; reason: string }> {
  // If an open PR already implements this issue, check out THAT branch (not a
  // fresh fix branch) so the cruncher can verify-and-merge existing work
  // instead of re-implementing it. Best-effort: on any detection failure we
  // fall through to the normal fresh-branch path.
  try {
    const issueBranch = issueBranchName(chosenNumber, title);
    const openPr = await findOpenPrForIssue({ project: projectName, projPath, issueNumber: chosenNumber, issueBranch });
    if (openPr) {
      const co = await checkoutPrBranch({ projectName, projPath, branch: openPr.branch });
      if (co.status === 'pipeline-running') return { ok: false, reason: `branch_pipeline_running: ${co.blockingJobId}` };
      if (co.status === 'error') return { ok: false, reason: `pr_branch_checkout_failed: ${co.detail}` };
      if (co.status === 'skipped' && co.cause === 'dirty-tree') return { ok: false, reason: `branch_dirty_tree: ${co.reason}` };
      if (co.status === 'created' || co.status === 'reused' || co.status === 'already-on-branch') {
        return { ok: true, branch: { name: co.branch, status: co.status }, openPr };
      }
    }
  } catch {
    // fall through to fresh-branch path
  }

  const branchResult = await ensureIssueBranch({
    projectName,
    projPath,
    issueNumber: chosenNumber,
    issueTitle: title,
  });
  if (branchResult.status === 'pipeline-running') {
    return { ok: false, reason: `branch_pipeline_running: ${branchResult.blockingJobId}` };
  }
  if (branchResult.status === 'error') {
    return { ok: false, reason: `branch_creation_failed: ${branchResult.detail}` };
  }
  if (branchResult.status === 'skipped') {
    // A dirty/stranded working tree means the issue work CANNOT be isolated onto
    // its own branch. Proceeding would run the issue agent — and let a
    // release-after-run push its work — directly on the default branch, entangled
    // with the stranded changes and bypassing the PR flow. Abort the pick so the
    // issue-cruncher stops (its skill treats a non-null `reason` as a hard stop)
    // instead of working exposed on the default branch.
    if (branchResult.cause === 'dirty-tree') {
      return { ok: false, reason: `branch_dirty_tree: ${branchResult.reason}` };
    }
    // Legitimate skip — project opted out of auto-branching, or the branch is
    // already merged (issue is done). The agent stays on the current branch.
    return { ok: true, branch: branchResult.branch ? { name: branchResult.branch, status: 'skipped' } : null };
  }
  return { ok: true, branch: { name: branchResult.branch, status: branchResult.status } };
}

async function handlePickTop(
  projectName: string,
  projPath: string,
  forceRefresh: boolean,
): Promise<NextResponse> {
  const listed = await ensureIssueList(projectName, projPath, forceRefresh);
  if ('detail' in listed) {
    return NextResponse.json({ detail: listed.detail }, { status: listed.status });
  }
  if (listed.ghError) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: `list_fetch_failed: ${listed.ghError}`,
      cached: false,
      cachedAt: listed.fetchedAt,
    } satisfies PickTopResponse, { status: 200 });
  }

  const picked = pickEligibleIssue(listed.issues, projPath);
  if (!picked) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: 'no_eligible_issue',
      cached: false,
      cachedAt: listed.fetchedAt,
    } satisfies PickTopResponse, { status: 200 });
  }

  const chosenNumber = typeof picked.number === 'number' ? picked.number : Number(picked.number);
  if (!Number.isFinite(chosenNumber) || chosenNumber <= 0) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: 'invalid_issue_number',
      cached: false,
      cachedAt: listed.fetchedAt,
    } satisfies PickTopResponse, { status: 200 });
  }

  // Detail cache check
  let detailCacheAvailable = true;
  if (!forceRefresh) {
    try {
      const cached = (await db
        .select()
        .from(schema.ghIssueDetailCache)
        .where(and(
          eq(schema.ghIssueDetailCache.project, projectName),
          eq(schema.ghIssueDetailCache.number, chosenNumber),
        ))
        .limit(1))[0] ?? null;
      if (cached && Date.now() / 1000 - cached.fetchedAt < CACHE_TTL_S) {
        const payload = JSON.parse(cached.payload) as PickTopResponse['issue'];
        const revalidatedPayload = revalidateCachedIssuePayload(payload, projPath);
        if (!revalidatedPayload) {
          return NextResponse.json({
            chosenIssue: null,
            issue: null,
            branch: null,
            reason: 'no_eligible_issue',
            cached: true,
            cachedAt: cached.fetchedAt,
          } satisfies PickTopResponse, { status: 200 });
        }
        const co = await checkoutForPickTop(projectName, projPath, chosenNumber, revalidatedPayload.title);
        if (!co.ok) {
          return NextResponse.json({
            chosenIssue: null,
            issue: null,
            branch: null,
            reason: co.reason,
            cached: true,
            cachedAt: cached.fetchedAt,
          } satisfies PickTopResponse, { status: 200 });
        }
        return NextResponse.json({
          chosenIssue: chosenNumber,
          issue: revalidatedPayload,
          branch: co.branch,
          openPr: co.openPr ?? null,
          reason: null,
          cached: true,
          cachedAt: cached.fetchedAt,
        } satisfies PickTopResponse, { status: 200 });
      }
    } catch (error) {
      if (!isMissingRelationError(error, 'gh_issue_detail_cache')) throw error;
      detailCacheAvailable = false;
    }
  }

  // Fetch detail with comments
  const detailFields = 'number,title,body,author,labels,state,url,comments';
  const detailResult = await exec(
    'gh',
    ['issue', 'view', String(chosenNumber), '--repo', listed.repo, '--json', detailFields],
    { timeout: 15000 },
  );
  if (detailResult.exitCode !== 0) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: `detail_fetch_failed: ${detailResult.stderr.trim() || 'gh issue view failed'}`,
      cached: false,
      cachedAt: Date.now() / 1000,
    } satisfies PickTopResponse, { status: 200 });
  }

  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(detailResult.stdout); } catch {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: 'detail_parse_failed',
      cached: false,
      cachedAt: Date.now() / 1000,
    } satisfies PickTopResponse, { status: 200 });
  }

  const { kept, droppedCount } = filterTrustedComments(parsed.comments, projPath);
  const issueAuthor = slimAuthor(parsed.author);
  if (!issueAuthor || !isUserTrusted(issueAuthor, projPath)) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: 'no_eligible_issue',
      cached: false,
      cachedAt: Date.now() / 1000,
    } satisfies PickTopResponse, { status: 200 });
  }
  const issuePayload: PickTopResponse['issue'] = {
    number: chosenNumber,
    title: typeof parsed.title === 'string' ? parsed.title : '',
    author: issueAuthor,
    state: typeof parsed.state === 'string' ? parsed.state : '',
    labels: slimLabels(parsed.labels),
    url: typeof parsed.url === 'string' ? parsed.url : '',
    body: typeof parsed.body === 'string' ? parsed.body : '',
    comments: kept,
    droppedCommentCount: droppedCount,
  };

  const fetchedAt = Date.now() / 1000;
  if (detailCacheAvailable) {
    try {
      await db.insert(schema.ghIssueDetailCache)
        .values({ project: projectName, number: chosenNumber, payload: JSON.stringify(issuePayload), fetchedAt })
        .onConflictDoUpdate({
          target: [schema.ghIssueDetailCache.project, schema.ghIssueDetailCache.number],
          set: { payload: JSON.stringify(issuePayload), fetchedAt },
        })
        .execute();
    } catch (error) {
      if (!isMissingRelationError(error, 'gh_issue_detail_cache')) throw error;
    }
  }

  const co = await checkoutForPickTop(projectName, projPath, chosenNumber, issuePayload.title);
  if (!co.ok) {
    return NextResponse.json({
      chosenIssue: null,
      issue: null,
      branch: null,
      reason: co.reason,
      cached: false,
      cachedAt: fetchedAt,
    } satisfies PickTopResponse, { status: 200 });
  }

  return NextResponse.json({
    chosenIssue: chosenNumber,
    issue: issuePayload,
    branch: co.branch,
    openPr: co.openPr ?? null,
    reason: null,
    cached: false,
    cachedAt: fetchedAt,
  } satisfies PickTopResponse, { status: 200 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';
  const trustedOnly = request.nextUrl.searchParams.get('trusted_only') === '1';
  const slim = request.nextUrl.searchParams.get('full') !== '1';
  // `?summary=1` returns just counts and open-PR branch metadata for parent
  // pollers (Project header) that don't render the lists themselves.
  const summary = request.nextUrl.searchParams.get('summary') === '1';
  // `?pick_top=1` returns a single chosen issue with body + trusted-author
  // comments only. Untrusted comments are dropped at the source.
  const pickTop = request.nextUrl.searchParams.get('pick_top') === '1';

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  if (pickTop) {
    return handlePickTop(projectName, projPath, forceRefresh);
  }

  const listed = await ensureIssueList(projectName, projPath, forceRefresh);
  if ('detail' in listed) {
    return NextResponse.json({ detail: listed.detail }, { status: listed.status });
  }
  const { repo, prs, issues, fetchedAt, cached, ghError } = listed;
  const filteredIssues = trustedOnly ? filterTrustedIssues(issues, projPath) : issues;
  if (summary) {
    return NextResponse.json({
      repo,
      prCount: prs.length,
      issueCount: filteredIssues.length,
      openPrBranches: prs.map((pr: unknown) => {
        const p = pr as Record<string, unknown>;
        return { branch: p.headRefName ?? '', number: p.number ?? 0 };
      }),
      error: ghError,
      cached,
      cachedAt: fetchedAt,
    });
  }
  const enriched = enrichRows(projectName, filteredIssues, prs);
  return NextResponse.json({
    repo,
    prs: slim ? enriched.prs.map(slimPR) : enriched.prs,
    issues: slim ? enriched.issues.map(slimIssue) : enriched.issues,
    error: ghError,
    cached,
    cachedAt: fetchedAt,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const body = await request.json().catch(() => ({}));
  const { prNumber, mergeMethod = 'merge', action = 'merge' } = body as {
    prNumber?: number;
    mergeMethod?: string;
    action?: 'merge' | 'approve';
  };

  if (!prNumber) return NextResponse.json({ detail: 'prNumber required' }, { status: 400 });
  if (!['merge', 'approve'].includes(action)) {
    return NextResponse.json({ detail: 'action must be merge or approve' }, { status: 400 });
  }
  if (action === 'merge' && !['merge', 'squash', 'rebase'].includes(mergeMethod)) {
    return NextResponse.json({ detail: 'mergeMethod must be merge, squash, or rebase' }, { status: 400 });
  }

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const expanded = projPath.startsWith('~') ? projPath.replace('~', homedir()) : projPath;
  const repo = await getGhRepo(projectName, expanded);
  if (!repo) return NextResponse.json({ detail: 'could not determine GitHub repo' }, { status: 422 });

  if (action === 'approve') {
    const result = await exec(
      'gh',
      ['pr', 'review', String(prNumber), '--repo', repo, '--approve'],
      { timeout: 30000 }
    );
    if (result.exitCode !== 0) {
      const errMsg = result.stderr.trim() || 'approve failed';
      return NextResponse.json({ detail: errMsg }, { status: 422 });
    }
    await db.delete(schema.ghIssuesCache)
      .where(eq(schema.ghIssuesCache.project, projectName))
      .execute();
    return NextResponse.json({ status: 'approved', pr: prNumber, repo });
  }

  // merge — try direct merge first. If the repo requires auto-merge
  // enablement AND branch protection hasn't been satisfied yet, gh returns
  // a "Pull request Auto merge is not allowed for this repository" error,
  // which is an actionable signal: approve first, then retry.
  const tryMerge = async (autoFlag: boolean) => {
    const args = ['pr', 'merge', String(prNumber), '--repo', repo, `--${mergeMethod}`];
    if (autoFlag) args.push('--auto');
    return exec('gh', args, { timeout: 30000 });
  };

  let result = await tryMerge(false);
  // Fall back to `--auto` (merge-when-green) ONLY for genuinely pending required
  // checks. A conflict ("not mergeable: the merge commit cannot be cleanly
  // created") must NOT retry with --auto: --auto can't resolve a conflict, and on
  // a repo without auto-merge enabled that retry fails with a misleading
  // "Auto merge is not allowed for this repository" that masks the real reason.
  // See lib/github/merge-error.ts.
  let autoEnabled = false;
  if (result.exitCode !== 0 && isChecksPendingError(result.stderr)) {
    result = await tryMerge(true);
    autoEnabled = true;
  }

  if (result.exitCode !== 0) {
    return NextResponse.json({ detail: friendlyMergeError(prNumber, result.stderr) }, { status: 422 });
  }

  // Resolve any outstanding pr-wait HITL for this PR — the merge is its
  // resolution — so the inbox manual-merge card clears deterministically
  // instead of lingering once the cache is deleted below. Skip when we only
  // ENABLED auto-merge (checks still pending): the PR has NOT landed yet, so
  // its manual-merge card must stay until it actually merges (never a silent
  // stop for a PR that could still fail its checks and never ship).
  if (!autoEnabled) {
    resolvePrWaitHitlForMergedPr(projectName, prNumber);
  }

  // Invalidate cache so next GET fetches fresh data
  await db.delete(schema.ghIssuesCache)
    .where(eq(schema.ghIssuesCache.project, projectName))
    .execute();

  // Post-merge cleanup: return the working tree to the default branch and
  // pull so the next task starts clean. Stash any uncommitted work first so
  // checkout doesn't fail on dirty trees, then restore it afterwards.
  // This is transactional: if checkout fails we return an error so the caller
  // knows the tree is still on the feature branch.
  let switchedBranch: string | null = null;
  let switchError: string | null = null;
  try {
    const symR = await exec('git', ['-C', expanded, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
    let mainBranch = 'main';
    if (symR.exitCode === 0) {
      const m = symR.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (m) mainBranch = m[1];
    }
    const curR = await exec('git', ['-C', expanded, 'branch', '--show-current'], { timeout: 5000 });
    if (curR.stdout.trim() === mainBranch) {
      await exec('git', ['-C', expanded, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
      switchedBranch = mainBranch;
    } else {
      const statusR = await exec('git', ['-C', expanded, 'status', '--porcelain'], { timeout: 5000 });
      const dirty = statusR.stdout.trim().length > 0;
      let stashed = false;
      if (dirty) {
        const stashR = await exec('git', ['-C', expanded, 'stash', 'push', '-u', '-m', `tamtam: pre-merge-switch ${Date.now()}`], { timeout: 10000 });
        stashed = stashR.exitCode === 0 && !/No local changes/i.test(stashR.stdout);
      }
      const coR = await exec('git', ['-C', expanded, 'checkout', mainBranch], { timeout: 10000 });
      if (coR.exitCode !== 0) {
        if (stashed) await exec('git', ['-C', expanded, 'stash', 'pop'], { timeout: 10000 });
        switchError = `Failed to switch to ${mainBranch} after merge: ${coR.stderr.trim() || coR.stdout.trim() || 'checkout failed'}`;
      } else {
        await exec('git', ['-C', expanded, 'pull', '--ff-only', 'origin', mainBranch], { timeout: 30000 });
        if (stashed) await exec('git', ['-C', expanded, 'stash', 'pop'], { timeout: 10000 });
        switchedBranch = mainBranch;
      }
    }
  } catch (e) {
    switchError = `Post-merge checkout error: ${e instanceof Error ? e.message : String(e)}`;
  }

  clearProjectDataCache();

  if (switchError) {
    return NextResponse.json({ status: 'merged_dirty', pr: prNumber, repo, switchedTo: null, switchError }, { status: 207 });
  }

  return NextResponse.json({ status: 'merged', pr: prNumber, repo, switchedTo: switchedBranch });
}
