import { exec } from '@/lib/shared/shell';

/**
 * PR review-comment fetching + formatting for the `respond-to-review` flow.
 *
 * The fetch helpers shell out to `gh`; the grouping/formatting helpers are pure
 * so they can be unit-tested without a GitHub round-trip.
 */

export interface PrReviewComment {
  id: number;
  path: string;
  line: number | null;
  diffHunk: string;
  body: string;
  author: string;
  /** Non-null when this comment is a reply within an existing thread. */
  inReplyToId: number | null;
}

export interface PrTopLevelReview {
  author: string;
  body: string;
  state: string;
}

export interface PrReviewFeedback {
  comments: PrReviewComment[];
  reviews: PrTopLevelReview[];
}

export interface GroupedFileComments {
  path: string;
  comments: PrReviewComment[];
}

interface RawApiComment {
  id?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  diff_hunk?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  in_reply_to_id?: unknown;
}

interface RawReviewsPayload {
  reviews?: Array<{ author?: { login?: unknown } | null; body?: unknown; state?: unknown }>;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize the REST `pulls/:n/comments` payload into typed comments. */
export function parseReviewComments(json: string): PrReviewComment[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: PrReviewComment[] = [];
  for (const item of raw as RawApiComment[]) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'number' ? item.id : Number(item.id);
    if (!Number.isInteger(id)) continue;
    const line =
      typeof item.line === 'number'
        ? item.line
        : typeof item.original_line === 'number'
          ? item.original_line
          : null;
    out.push({
      id,
      path: toStr(item.path),
      line,
      diffHunk: toStr(item.diff_hunk),
      body: toStr(item.body),
      author: toStr(item.user?.login),
      inReplyToId:
        typeof item.in_reply_to_id === 'number' && Number.isInteger(item.in_reply_to_id)
          ? item.in_reply_to_id
          : null,
    });
  }
  return out;
}

/** Normalize `gh pr view --json reviews` into non-empty top-level reviews. */
export function parseTopLevelReviews(json: string): PrTopLevelReview[] {
  let raw: RawReviewsPayload;
  try {
    raw = JSON.parse(json) as RawReviewsPayload;
  } catch {
    return [];
  }
  const reviews = Array.isArray(raw?.reviews) ? raw.reviews : [];
  const out: PrTopLevelReview[] = [];
  for (const r of reviews) {
    const body = toStr(r?.body).trim();
    if (!body) continue; // approvals with no prose carry no actionable request
    out.push({ author: toStr(r?.author?.login), body, state: toStr(r?.state) });
  }
  return out;
}

/**
 * Root inline comments only (replies are dropped so we don't re-address a
 * thread we already answered), grouped by file and ordered by line. Files with
 * only reply comments produce no group.
 */
export function groupCommentsByFile(comments: PrReviewComment[]): GroupedFileComments[] {
  const roots = comments.filter((c) => c.inReplyToId === null && c.path);
  const byPath = new Map<string, PrReviewComment[]>();
  for (const c of roots) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  const groups: GroupedFileComments[] = [];
  for (const [path, list] of byPath) {
    list.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    groups.push({ path, comments: list });
  }
  groups.sort((a, b) => a.path.localeCompare(b.path));
  return groups;
}

/** Count of actionable review items (root inline comments + prose reviews). */
export function countUnresolved(feedback: PrReviewFeedback): number {
  const roots = feedback.comments.filter((c) => c.inReplyToId === null && c.path).length;
  return roots + feedback.reviews.length;
}

/**
 * Render the reviewer feedback as a prompt block. Gives Claude the same spatial
 * context the reviewer had: file, line, the diff hunk, and the comment body.
 * The caller is responsible for wrapping the result as untrusted content.
 */
export function formatCommentsForPrompt(feedback: PrReviewFeedback): string {
  const groups = groupCommentsByFile(feedback.comments);
  const parts: string[] = [];

  for (const group of groups) {
    parts.push(`### ${group.path}`);
    for (const c of group.comments) {
      const loc = c.line != null ? `line ${c.line}` : 'file-level';
      parts.push(`- Comment #${c.id} (${loc}) by @${c.author || 'reviewer'}:`);
      if (c.diffHunk.trim()) {
        parts.push('  Diff context:');
        parts.push('  ```diff');
        for (const hl of c.diffHunk.split('\n')) parts.push(`  ${hl}`);
        parts.push('  ```');
      }
      parts.push(`  Reviewer said: ${c.body.trim()}`);
    }
    parts.push('');
  }

  if (feedback.reviews.length) {
    parts.push('### Overall review comments');
    for (const r of feedback.reviews) {
      const state = r.state ? ` [${r.state}]` : '';
      parts.push(`- @${r.author || 'reviewer'}${state}: ${r.body.trim()}`);
    }
    parts.push('');
  }

  return parts.join('\n').trim();
}

/**
 * Reply body posted under a review-comment thread once Claude has (or has
 * deliberately not) addressed it. References the fix commit SHA when present.
 */
export function formatReplyBody(commitSha: string | null, note?: string): string {
  const sha = commitSha?.trim();
  if (sha) {
    const short = sha.slice(0, 12);
    const extra = note?.trim() ? ` ${note.trim()}` : '';
    return `Addressed in ${short}.${extra}`.trim();
  }
  const explanation = note?.trim() || 'No code change was made for this comment.';
  return `Not addressed: ${explanation}`;
}

/**
 * Fetch inline review comments (REST, carries `diff_hunk`) and top-level review
 * bodies (`gh pr view`). Returns empty arrays on failure so callers can treat
 * "no feedback" and "fetch failed" uniformly via `countUnresolved`.
 */
export async function fetchPrReviewFeedback(
  projPath: string,
  repo: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<PrReviewFeedback> {
  const [commentsR, reviewsR] = await Promise.all([
    exec(
      'gh',
      ['api', `repos/${repo}/pulls/${prNumber}/comments`, '--paginate'],
      { cwd: projPath, timeout: 30000, signal },
    ),
    exec('gh', ['pr', 'view', String(prNumber), '--json', 'reviews'], {
      cwd: projPath,
      timeout: 30000,
      signal,
    }),
  ]);
  return {
    comments: commentsR.exitCode === 0 ? parseReviewComments(commentsR.stdout) : [],
    reviews: reviewsR.exitCode === 0 ? parseTopLevelReviews(reviewsR.stdout) : [],
  };
}
