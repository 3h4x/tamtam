import { describe, it, expect } from 'vitest';
import { findActivePrWait } from '@/lib/pipeline/start-release';
import type { JobData } from '@/lib/jobs/types';

const NOW = 1_700_000_000_000; // ms

// startedAt is stored in epoch SECONDS for live jobs; the helper also tolerates
// ms-epoch values (> 1e12).
function job(over: Partial<JobData> = {}): JobData {
  return {
    id: 'j',
    project: 'tamtam',
    kind: 'pr-wait',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: NOW / 1000,
    finishedAt: null,
    exitCode: null,
    seen: false,
    ...over,
  } as JobData;
}

describe('findActivePrWait — serialize releases across the pr-wait window', () => {
  it('returns a running pr-wait → a new release is blocked (no concurrent PR)', () => {
    const jobs = [job({ id: 'pw', startedAt: NOW / 1000 - 60 })];
    expect(findActivePrWait(jobs, 'tamtam', NOW)?.id).toBe('pw');
  });

  it('ignores a finished pr-wait (PR already merged)', () => {
    expect(findActivePrWait([job({ id: 'pw', finishedAt: NOW / 1000 })], 'tamtam', NOW)).toBeNull();
  });

  it('ignores a pr-wait for a different project (cross-repo work is fine)', () => {
    expect(findActivePrWait([job({ id: 'pw', project: 'other' })], 'tamtam', NOW)).toBeNull();
  });

  it('ignores non-pr-wait pipeline jobs (those are handled by other gates)', () => {
    expect(findActivePrWait([job({ id: 'r', kind: 'release' })], 'tamtam', NOW)).toBeNull();
  });

  it('blocks while within the 120-min backstop', () => {
    const jobs = [job({ id: 'pw', startedAt: (NOW - 60 * 60 * 1000) / 1000 })];
    expect(findActivePrWait(jobs, 'tamtam', NOW)?.id).toBe('pw');
  });

  it('does NOT freeze the project forever — a pr-wait past the backstop is ignored', () => {
    const jobs = [job({ id: 'pw', startedAt: (NOW - 121 * 60 * 1000) / 1000 })];
    expect(findActivePrWait(jobs, 'tamtam', NOW)).toBeNull();
  });

  it('tolerates ms-epoch startedAt values', () => {
    const jobs = [job({ id: 'pw', startedAt: NOW - 60_000 })]; // > 1e12 → treated as ms
    expect(findActivePrWait(jobs, 'tamtam', NOW)?.id).toBe('pw');
  });

  it('does NOT block on a pr-wait with an unparseable start time (0/null) — would otherwise freeze releases forever', () => {
    // A pr-wait whose start time can't be aged out must fall to the safe side
    // (release allowed), not block indefinitely past the backstop's reach.
    expect(findActivePrWait([job({ id: 'pw', startedAt: 0 })], 'tamtam', NOW)).toBeNull();
    expect(findActivePrWait([job({ id: 'pw', startedAt: null as unknown as number })], 'tamtam', NOW)).toBeNull();
  });
});
