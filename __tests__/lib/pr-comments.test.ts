import { describe, it, expect } from 'vitest';
import {
  parseReviewComments,
  parseTopLevelReviews,
  groupCommentsByFile,
  countUnresolved,
  formatCommentsForPrompt,
  formatReplyBody,
  type PrReviewComment,
} from '@/lib/github/pr-comments';

function comment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    id: 1,
    path: 'src/a.ts',
    line: 10,
    diffHunk: '@@ -1,2 +1,2 @@\n-old\n+new',
    body: 'handle null here',
    author: 'reviewer',
    inReplyToId: null,
    ...overrides,
  };
}

describe('parseReviewComments', () => {
  it('normalizes REST payload and falls back to original_line', () => {
    const json = JSON.stringify([
      { id: 5, path: 'x.ts', line: null, original_line: 42, diff_hunk: 'h', body: 'b', user: { login: 'u' }, in_reply_to_id: 3 },
    ]);
    const [c] = parseReviewComments(json);
    expect(c).toEqual({
      id: 5,
      path: 'x.ts',
      line: 42,
      diffHunk: 'h',
      body: 'b',
      author: 'u',
      inReplyToId: 3,
    });
  });

  it('returns [] for malformed JSON or non-array payloads', () => {
    expect(parseReviewComments('not json')).toEqual([]);
    expect(parseReviewComments('{"a":1}')).toEqual([]);
  });

  it('skips entries without an integer id', () => {
    const json = JSON.stringify([{ path: 'x.ts' }, { id: 7, path: 'y.ts' }]);
    expect(parseReviewComments(json).map((c) => c.id)).toEqual([7]);
  });
});

describe('parseTopLevelReviews', () => {
  it('keeps only reviews with a non-empty body', () => {
    const json = JSON.stringify({
      reviews: [
        { author: { login: 'a' }, body: '   ', state: 'APPROVED' },
        { author: { login: 'b' }, body: 'please add a test', state: 'CHANGES_REQUESTED' },
      ],
    });
    const out = parseTopLevelReviews(json);
    expect(out).toEqual([{ author: 'b', body: 'please add a test', state: 'CHANGES_REQUESTED' }]);
  });

  it('returns [] on malformed input', () => {
    expect(parseTopLevelReviews('nope')).toEqual([]);
    expect(parseTopLevelReviews('{}')).toEqual([]);
  });
});

describe('groupCommentsByFile', () => {
  it('groups roots by file, sorts within file by line and files alphabetically', () => {
    const comments = [
      comment({ id: 1, path: 'src/b.ts', line: 20 }),
      comment({ id: 2, path: 'src/a.ts', line: 30 }),
      comment({ id: 3, path: 'src/a.ts', line: 5 }),
    ];
    const groups = groupCommentsByFile(comments);
    expect(groups.map((g) => g.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(groups[0].comments.map((c) => c.id)).toEqual([3, 2]);
    expect(groups[1].comments.map((c) => c.id)).toEqual([1]);
  });

  it('drops reply comments and comments with no path', () => {
    const comments = [
      comment({ id: 1, inReplyToId: 99 }),
      comment({ id: 2, path: '' }),
      comment({ id: 3 }),
    ];
    const groups = groupCommentsByFile(comments);
    expect(groups).toHaveLength(1);
    expect(groups[0].comments.map((c) => c.id)).toEqual([3]);
  });
});

describe('countUnresolved', () => {
  it('counts root inline comments plus top-level reviews', () => {
    const feedback = {
      comments: [comment({ id: 1 }), comment({ id: 2, inReplyToId: 1 })],
      reviews: [{ author: 'r', body: 'x', state: 'COMMENTED' }],
    };
    expect(countUnresolved(feedback)).toBe(2); // one root comment + one review
  });

  it('is zero for empty feedback', () => {
    expect(countUnresolved({ comments: [], reviews: [] })).toBe(0);
  });
});

describe('formatCommentsForPrompt', () => {
  it('includes file heading, line, diff hunk, comment id, and overall reviews', () => {
    const out = formatCommentsForPrompt({
      comments: [comment({ id: 12, path: 'src/a.ts', line: 10, body: 'handle null' })],
      reviews: [{ author: 'rev', body: 'looks risky', state: 'CHANGES_REQUESTED' }],
    });
    expect(out).toContain('### src/a.ts');
    expect(out).toContain('Comment #12');
    expect(out).toContain('line 10');
    expect(out).toContain('```diff');
    expect(out).toContain('handle null');
    expect(out).toContain('### Overall review comments');
    expect(out).toContain('[CHANGES_REQUESTED]');
    expect(out).toContain('looks risky');
  });

  it('labels comments with no line as file-level and omits empty diff blocks', () => {
    const out = formatCommentsForPrompt({
      comments: [comment({ id: 3, line: null, diffHunk: '' })],
      reviews: [],
    });
    expect(out).toContain('file-level');
    expect(out).not.toContain('```diff');
  });
});

describe('formatReplyBody', () => {
  it('references the shortened commit SHA when addressed', () => {
    expect(formatReplyBody('abcdef1234567890')).toBe('Addressed in abcdef123456.');
  });

  it('appends an optional note to an addressed reply', () => {
    expect(formatReplyBody('abcdef1234567890', 'added a guard')).toBe('Addressed in abcdef123456. added a guard');
  });

  it('explains when nothing was changed', () => {
    expect(formatReplyBody(null)).toBe('Not addressed: No code change was made for this comment.');
    expect(formatReplyBody('  ', 'behavior is intentional')).toBe('Not addressed: behavior is intentional');
  });
});
