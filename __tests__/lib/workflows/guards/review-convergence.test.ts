import { describe, it, expect } from 'vitest';
import {
  findingsFingerprint,
  fixContradictsReview,
  reviewIsStuck,
} from '@/lib/workflows/guards/review-convergence';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> & Pick<JobData, 'id' | 'kind'>): JobData {
  return {
    project: 'p',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: Date.now() / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  } as JobData;
}

describe('findingsFingerprint', () => {
  it('uses structured Finding IDs when present', () => {
    const log = `
Findings:
- Finding ID: alpha
  Severity: high
- Finding ID: beta
  Severity: low

Verdict: NEEDS ATTENTION
`;
    expect(findingsFingerprint(log)).toBe('ids:alpha|beta');
  });

  it('falls back to a normalized prose hash when no Finding IDs', () => {
    const a = findingsFingerprint('The validator misses empty strings.\nVerdict: NEEDS ATTENTION');
    const b = findingsFingerprint('  THE VALIDATOR MISSES empty strings.  ');
    expect(a).toBe(b);
  });

  it('strips fenced code blocks before hashing', () => {
    const a = findingsFingerprint('foo\n```ts\nlet x = 1\n```\nbar');
    const b = findingsFingerprint('foo\n\nbar');
    expect(a).toBe(b);
  });
});

describe('reviewIsStuck', () => {
  const PROSE_FINDING = 'The validator misses empty strings.\nVerdict: NEEDS ATTENTION';
  const cur = makeJob({
    id: 'r2',
    kind: 'review',
    releaseId: 'rel-1',
    startedAt: 200,
    exitCode: 0,
  });

  it('returns false for a standalone (no releaseId) review', () => {
    const standalone = makeJob({ id: 'r2', kind: 'review', releaseId: null });
    expect(reviewIsStuck(standalone, { listJobs: () => [], readParsedLog: () => '' })).toBe(false);
  });

  it('returns false when there is no prior review in the release', () => {
    expect(
      reviewIsStuck(cur, { listJobs: () => [cur], readParsedLog: () => PROSE_FINDING }),
    ).toBe(false);
  });

  it('returns true when current and prior review have identical findings', () => {
    const prev = makeJob({ id: 'r1', kind: 'review', releaseId: 'rel-1', startedAt: 100, exitCode: 0 });
    expect(
      reviewIsStuck(cur, {
        listJobs: () => [prev, cur],
        readParsedLog: () => PROSE_FINDING,
      }),
    ).toBe(true);
  });

  it('returns false when current and prior review differ', () => {
    const prev = makeJob({ id: 'r1', kind: 'review', releaseId: 'rel-1', startedAt: 100, exitCode: 0 });
    let calls = 0;
    expect(
      reviewIsStuck(cur, {
        listJobs: () => [prev, cur],
        readParsedLog: () => (calls++ === 0 ? PROSE_FINDING : 'A completely different finding.'),
      }),
    ).toBe(false);
  });

  it('ignores reviews from other releases', () => {
    const otherRelease = makeJob({
      id: 'r0',
      kind: 'review',
      releaseId: 'rel-OTHER',
      startedAt: 50,
      exitCode: 0,
    });
    expect(
      reviewIsStuck(cur, {
        listJobs: () => [otherRelease, cur],
        readParsedLog: () => PROSE_FINDING,
      }),
    ).toBe(false);
  });
});

describe('fixContradictsReview', () => {
  const cur = makeJob({
    id: 'r2',
    kind: 'review',
    releaseId: 'rel-1',
    startedAt: 200,
  });

  it('returns no contradiction when no prior fix exists', () => {
    expect(
      fixContradictsReview(cur, { listJobs: () => [cur], readParsedLog: () => '' }),
    ).toEqual({ stuck: false, ids: [] });
  });

  it('flags the case where fix claimed an ID fixed but review still flags it', () => {
    const fix = makeJob({
      id: 'f1',
      kind: 'fix',
      releaseId: 'rel-1',
      startedAt: 150,
      exitCode: 0,
    });
    const fixLog = `
Fix checklist:
- Finding ID: alpha
  Status: fixed
  Files changed: src/a.ts
- Finding ID: beta
  Status: fixed
  Files changed: src/b.ts
`;
    const reviewLog = `
Findings:
- Finding ID: alpha
  Severity: high
Verdict: NEEDS ATTENTION
`;
    const r = fixContradictsReview(cur, {
      listJobs: () => [fix, cur],
      readParsedLog: (job) => (job.id === 'f1' ? fixLog : reviewLog),
    });
    expect(r.stuck).toBe(true);
    expect(r.ids).toEqual(['alpha']);
  });

  it('does not flag when fix claimed Status: not fixed', () => {
    const fix = makeJob({ id: 'f1', kind: 'fix', releaseId: 'rel-1', startedAt: 150, exitCode: 0 });
    const fixLog = `
Fix checklist:
- Finding ID: alpha
  Status: not fixed
`;
    const reviewLog = `
Findings:
- Finding ID: alpha
Verdict: NEEDS ATTENTION
`;
    expect(
      fixContradictsReview(cur, {
        listJobs: () => [fix, cur],
        readParsedLog: (job) => (job.id === 'f1' ? fixLog : reviewLog),
      }).stuck,
    ).toBe(false);
  });

  it('does not flag when the still-flagged ID is different from what fix claimed', () => {
    const fix = makeJob({ id: 'f1', kind: 'fix', releaseId: 'rel-1', startedAt: 150, exitCode: 0 });
    const fixLog = `
Fix checklist:
- Finding ID: alpha
  Status: fixed
`;
    const reviewLog = `
Findings:
- Finding ID: gamma
Verdict: NEEDS ATTENTION
`;
    expect(
      fixContradictsReview(cur, {
        listJobs: () => [fix, cur],
        readParsedLog: (job) => (job.id === 'f1' ? fixLog : reviewLog),
      }).stuck,
    ).toBe(false);
  });

  it('ignores fixes from other releases', () => {
    const otherFix = makeJob({
      id: 'f1',
      kind: 'fix',
      releaseId: 'rel-OTHER',
      startedAt: 150,
      exitCode: 0,
    });
    const fixLog = `Fix checklist:\n- Finding ID: alpha\n  Status: fixed\n`;
    const reviewLog = `Findings:\n- Finding ID: alpha\nVerdict: NEEDS ATTENTION\n`;
    expect(
      fixContradictsReview(cur, {
        listJobs: () => [otherFix, cur],
        readParsedLog: (job) => (job.id === 'f1' ? fixLog : reviewLog),
      }).stuck,
    ).toBe(false);
  });
});
