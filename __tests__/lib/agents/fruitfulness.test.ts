import { describe, expect, it } from 'vitest';
import {
  computeFruitfulness,
  isFruitful,
  jobToSample,
  type FruitfulnessSample,
} from '@/lib/agents/fruitfulness';
import type { JobData } from '@/lib/jobs/types';

function sample(overrides: Partial<FruitfulnessSample> = {}): FruitfulnessSample {
  return {
    jobId: 'j-1',
    startedAt: 1_700_000_000,
    exitCode: 0,
    modifiedFilesCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides,
  };
}

describe('isFruitful', () => {
  it('returns false when no files and no lines changed', () => {
    expect(isFruitful(sample())).toBe(false);
  });
  it('returns true when at least one file changed', () => {
    expect(isFruitful(sample({ modifiedFilesCount: 1 }))).toBe(true);
  });
  it('returns true when lines were added even without files (binary rename edge)', () => {
    expect(isFruitful(sample({ linesAdded: 5 }))).toBe(true);
  });
  it('returns true on a pure deletion', () => {
    expect(isFruitful(sample({ linesRemoved: 3 }))).toBe(true);
  });
});

describe('computeFruitfulness', () => {
  it('returns zeros for an empty sample (no signal ⇒ no penalty)', () => {
    expect(computeFruitfulness([])).toEqual({
      runs: 0,
      fruitfulRuns: 0,
      rate: 0,
      totalLinesChanged: 0,
      totalFilesChanged: 0,
      lastRunAt: null,
    });
  });

  it('counts fruitful vs total correctly across mixed samples', () => {
    const stats = computeFruitfulness([
      sample({ jobId: 'a', modifiedFilesCount: 2, linesAdded: 10, linesRemoved: 3 }),
      sample({ jobId: 'b' }), // empty
      sample({ jobId: 'c', modifiedFilesCount: 1, linesAdded: 1 }),
      sample({ jobId: 'd' }), // empty
    ]);
    expect(stats.runs).toBe(4);
    expect(stats.fruitfulRuns).toBe(2);
    expect(stats.rate).toBeCloseTo(0.5);
    expect(stats.totalLinesChanged).toBe(10 + 3 + 1);
    expect(stats.totalFilesChanged).toBe(3);
  });

  it('reports lastRunAt as the most recent startedAt', () => {
    const stats = computeFruitfulness([
      sample({ jobId: 'a', startedAt: 100 }),
      sample({ jobId: 'b', startedAt: 300 }),
      sample({ jobId: 'c', startedAt: 200 }),
    ]);
    expect(stats.lastRunAt).toBe(300);
  });

  it('treats every-run-empty as rate=0 (the demotion case)', () => {
    const stats = computeFruitfulness([sample(), sample(), sample(), sample(), sample()]);
    expect(stats.runs).toBe(5);
    expect(stats.fruitfulRuns).toBe(0);
    expect(stats.rate).toBe(0);
  });
});

describe('jobToSample', () => {
  function makeJob(overrides: Partial<JobData> = {}): JobData {
    return {
      id: 'j',
      project: 'p',
      kind: 'agent:improve',
      prompt: null,
      pid: 1,
      logPath: null,
      startedAt: 1_700_000_000,
      finishedAt: 1_700_000_100,
      exitCode: 0,
      seen: false,
      ...overrides,
    };
  }

  it('returns null for non-agent jobs', () => {
    expect(jobToSample(makeJob({ kind: 'test' }))).toBeNull();
    expect(jobToSample(makeJob({ kind: 'review' }))).toBeNull();
    expect(jobToSample(makeJob({ kind: 'release' }))).toBeNull();
  });

  it('returns null for unfinished agent jobs (no usable signal yet)', () => {
    expect(jobToSample(makeJob({ finishedAt: null, exitCode: null }))).toBeNull();
  });

  it('parses modifiedFiles JSON into a count', () => {
    const s = jobToSample(makeJob({
      modifiedFiles: JSON.stringify([
        { path: 'a.ts', status: 'M' },
        { path: 'b.ts', status: 'A' },
      ]),
      linesAdded: 10,
      linesRemoved: 4,
    }));
    expect(s).not.toBeNull();
    expect(s!.modifiedFilesCount).toBe(2);
    expect(s!.linesAdded).toBe(10);
    expect(s!.linesRemoved).toBe(4);
  });

  it('does not count low-confidence dirty-baseline files as fruitful output', () => {
    const s = jobToSample(makeJob({
      modifiedFiles: JSON.stringify([
        { path: 'pre-existing.ts', status: 'M', confidence: 'low' },
      ]),
      linesAdded: 0,
      linesRemoved: 0,
    }));
    expect(s).not.toBeNull();
    expect(s!.modifiedFilesCount).toBe(0);
    expect(isFruitful(s!)).toBe(false);
  });

  it('treats malformed modifiedFiles JSON as zero files instead of crashing', () => {
    const s = jobToSample(makeJob({ modifiedFiles: 'not-json' }));
    expect(s).not.toBeNull();
    expect(s!.modifiedFilesCount).toBe(0);
  });

  it('tolerates null lines columns from pre-migration rows', () => {
    const s = jobToSample(makeJob({ linesAdded: null, linesRemoved: null }));
    expect(s).not.toBeNull();
    expect(s!.linesAdded).toBe(0);
    expect(s!.linesRemoved).toBe(0);
  });
});
