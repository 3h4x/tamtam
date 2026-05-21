import { describe, expect, it } from 'vitest';
import {
  buildReleaseStepChain,
  getEffectiveReleaseChainTail,
  PIPELINE_CHAIN_GAP_SEC,
  RESUMABLE_RELEASE_STEP_KINDS,
} from '@/lib/pipeline/release-chain';
import type { JobData } from '@/lib/jobs/types';

function makeJob(overrides: Partial<JobData> & { id: string; startedAt: number }): JobData {
  return {
    project: 'p',
    kind: 'test',
    prompt: null,
    pid: 0,
    logPath: null,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...overrides,
  };
}

describe('buildReleaseStepChain', () => {
  it('returns an empty chain when there are no candidates', () => {
    const release = makeJob({ id: 'r', startedAt: 100, kind: 'release' });
    expect(buildReleaseStepChain(release, [])).toEqual([]);
  });

  it('includes a candidate that starts within the gap window of the release', () => {
    const release = makeJob({ id: 'r', startedAt: 100, kind: 'release' });
    const test = makeJob({ id: 't', startedAt: 110, finishedAt: 120, kind: 'test' });
    expect(buildReleaseStepChain(release, [test])).toEqual([test]);
  });

  it('breaks the chain at the first gap larger than PIPELINE_CHAIN_GAP_SEC', () => {
    const release = makeJob({ id: 'r', startedAt: 1000, kind: 'release' });
    // chain edge moves with each finishedAt
    const a = makeJob({ id: 'a', startedAt: 1010, finishedAt: 1020, kind: 'test' });
    const b = makeJob({ id: 'b', startedAt: 1030, finishedAt: 1040, kind: 'review' });
    // c starts > PIPELINE_CHAIN_GAP_SEC seconds after the previous edge (1040)
    const c = makeJob({ id: 'c', startedAt: 1040 + PIPELINE_CHAIN_GAP_SEC + 1, finishedAt: 1200, kind: 'commit' });
    expect(buildReleaseStepChain(release, [a, b, c]).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('sorts candidates by startedAt before walking (input order is not required)', () => {
    const release = makeJob({ id: 'r', startedAt: 100, kind: 'release' });
    const a = makeJob({ id: 'a', startedAt: 110, finishedAt: 120, kind: 'test' });
    const b = makeJob({ id: 'b', startedAt: 130, finishedAt: 140, kind: 'review' });
    expect(buildReleaseStepChain(release, [b, a]).map((j) => j.id)).toEqual(['a', 'b']);
  });

  it('does not advance the edge when a candidate is still running (finishedAt=null)', () => {
    // The unfinished `b` does not extend the gap window. `c` must therefore
    // start within PIPELINE_CHAIN_GAP_SEC of `a.finishedAt` (the last known
    // edge) — not within that window of `b`. This is intentional: we don't
    // know how long `b` will take to finish, so we don't preemptively cover
    // work past it.
    const release = makeJob({ id: 'r', startedAt: 100, kind: 'release' });
    const a = makeJob({ id: 'a', startedAt: 110, finishedAt: 120, kind: 'test' });
    const b = makeJob({ id: 'b', startedAt: 130, finishedAt: null, kind: 'review' });
    const c = makeJob({ id: 'c', startedAt: 120 + PIPELINE_CHAIN_GAP_SEC + 1, finishedAt: 250, kind: 'commit' });
    const chain = buildReleaseStepChain(release, [a, b, c]).map((j) => j.id);
    expect(chain).toContain('a');
    expect(chain).toContain('b');
    expect(chain).not.toContain('c');
  });
});

describe('getEffectiveReleaseChainTail', () => {
  it('returns null for an empty chain', () => {
    expect(getEffectiveReleaseChainTail([])).toBeNull();
  });

  it('returns the single-job chain even if it is mark-dod', () => {
    const m = makeJob({ id: 'm', startedAt: 100, kind: 'mark-dod' });
    expect(getEffectiveReleaseChainTail([m])).toBe(m);
  });

  it('skips a trailing mark-dod and returns the prior step', () => {
    const test = makeJob({ id: 't', startedAt: 100, kind: 'test' });
    const dod = makeJob({ id: 'd', startedAt: 200, kind: 'mark-dod' });
    expect(getEffectiveReleaseChainTail([test, dod])).toBe(test);
  });

  it('returns the last job when the tail is not mark-dod', () => {
    const test = makeJob({ id: 't', startedAt: 100, kind: 'test' });
    const review = makeJob({ id: 'r', startedAt: 200, kind: 'review' });
    expect(getEffectiveReleaseChainTail([test, review])).toBe(review);
  });
});

describe('RESUMABLE_RELEASE_STEP_KINDS', () => {
  it('contains exactly the four resumable phase kinds', () => {
    // Locks the resumable-step contract: any pipeline change that
    // adds/removes a resumable kind must update this Set.
    expect([...RESUMABLE_RELEASE_STEP_KINDS].sort()).toEqual(['commit', 'fix', 'review', 'test']);
  });
});
