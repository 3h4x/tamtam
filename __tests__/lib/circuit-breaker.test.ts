import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobData } from '@/lib/jobs/types';
import {
  countRecentProjectFailures,
  isBreakerCountableKind,
  isCountableFailure,
} from '@/lib/pipeline/circuit-breaker';

function mkJob(partial: Partial<JobData>): JobData {
  return {
    id: 'j',
    project: 'demo',
    kind: 'run',
    prompt: null,
    pid: 0,
    logPath: null,
    startedAt: 0,
    finishedAt: 1000,
    exitCode: 1,
    seen: false,
    ...partial,
  };
}

describe('isBreakerCountableKind', () => {
  it('counts top-level run/release/agent kinds', () => {
    expect(isBreakerCountableKind('run')).toBe(true);
    expect(isBreakerCountableKind('release')).toBe(true);
    expect(isBreakerCountableKind('agent:issue-cruncher')).toBe(true);
  });
  it('excludes pipeline sub-steps', () => {
    expect(isBreakerCountableKind('review')).toBe(false);
    expect(isBreakerCountableKind('fix')).toBe(false);
    expect(isBreakerCountableKind('commit')).toBe(false);
    expect(isBreakerCountableKind('push')).toBe(false);
  });
});

describe('isCountableFailure', () => {
  it('is true for a finished top-level job with a failure code', () => {
    expect(isCountableFailure(mkJob({ kind: 'run', exitCode: 1 }))).toBe(true);
    expect(isCountableFailure(mkJob({ kind: 'release', exitCode: 137 }))).toBe(true);
  });
  it('is false for success, cancelled, running, or sub-step jobs', () => {
    expect(isCountableFailure(mkJob({ exitCode: 0 }))).toBe(false);
    expect(isCountableFailure(mkJob({ exitCode: -2 }))).toBe(false); // cancelled
    expect(isCountableFailure(mkJob({ exitCode: -3 }))).toBe(false); // cancelled
    expect(isCountableFailure(mkJob({ exitCode: null }))).toBe(false);
    expect(isCountableFailure(mkJob({ finishedAt: null, exitCode: 1 }))).toBe(false);
    expect(isCountableFailure(mkJob({ kind: 'review', exitCode: 1 }))).toBe(false);
  });
});

describe('countRecentProjectFailures', () => {
  const nowSec = 1_000_000;
  const windowSec = 3600; // 1h

  it('counts only this project’s in-window failures', () => {
    const jobs = [
      mkJob({ id: 'a', project: 'demo', exitCode: 1, finishedAt: nowSec - 100 }),
      mkJob({ id: 'b', project: 'demo', exitCode: 1, finishedAt: nowSec - 200 }),
      mkJob({ id: 'c', project: 'other', exitCode: 1, finishedAt: nowSec - 50 }), // other project
      mkJob({ id: 'd', project: 'demo', exitCode: 0, finishedAt: nowSec - 50 }), // success
      mkJob({ id: 'e', project: 'demo', exitCode: 1, finishedAt: nowSec - 7200 }), // outside window
    ];
    expect(countRecentProjectFailures(jobs, 'demo', nowSec, windowSec)).toBe(2);
  });

  it('returns 0 when nothing qualifies', () => {
    expect(countRecentProjectFailures([], 'demo', nowSec, windowSec)).toBe(0);
  });
});

// ── Orchestration: maybeTripCircuitBreaker auto-pause interaction ──
const state = vi.hoisted(() => ({
  settings: { project_failure_threshold: 3, project_failure_window_minutes: 60 },
  paused: false,
  jobs: [] as JobData[],
  pauseCalls: [] as string[],
  notifyEvents: [] as string[],
}));

vi.mock('@/lib/shared/config', () => ({ getSettings: () => state.settings }));
vi.mock('@/lib/shared/enabled-projects', () => ({ isProjectPaused: () => state.paused }));
vi.mock('@/lib/jobs/job-storage', () => ({ listJobs: () => state.jobs }));
vi.mock('@/lib/pipeline/pause-project', () => ({
  pauseProject: async (p: string) => { state.pauseCalls.push(p); return true; },
}));
vi.mock('@/lib/shared/notifications', () => ({
  notify: async (payload: { event: string }) => { state.notifyEvents.push(payload.event); },
}));

describe('maybeTripCircuitBreaker', () => {
  const nowSec = () => Date.now() / 1000;
  function failure(id: string): JobData {
    return mkJob({ id, project: 'demo', kind: 'run', exitCode: 1, finishedAt: nowSec() });
  }

  beforeEach(() => {
    state.settings = { project_failure_threshold: 3, project_failure_window_minutes: 60 };
    state.paused = false;
    state.jobs = [];
    state.pauseCalls = [];
    state.notifyEvents = [];
  });

  it('pauses + notifies once the threshold of failures is reached', async () => {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    const trigger = failure('trigger');
    state.jobs = [failure('a'), failure('b'), trigger];
    const tripped = await maybeTripCircuitBreaker(trigger);
    expect(tripped).toBe(true);
    expect(state.pauseCalls).toEqual(['demo']);
    expect(state.notifyEvents).toEqual(['circuit_breaker_tripped']);
  });

  it('does not pause below the threshold', async () => {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    const trigger = failure('trigger');
    state.jobs = [failure('a'), trigger]; // only 2, threshold 3
    expect(await maybeTripCircuitBreaker(trigger)).toBe(false);
    expect(state.pauseCalls).toEqual([]);
  });

  it('is a no-op when already paused (no re-notify)', async () => {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    state.paused = true;
    const trigger = failure('trigger');
    state.jobs = [failure('a'), failure('b'), trigger];
    expect(await maybeTripCircuitBreaker(trigger)).toBe(false);
    expect(state.pauseCalls).toEqual([]);
    expect(state.notifyEvents).toEqual([]);
  });

  it('is disabled when threshold is 0', async () => {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    state.settings = { project_failure_threshold: 0, project_failure_window_minutes: 60 };
    const trigger = failure('trigger');
    state.jobs = [failure('a'), failure('b'), failure('c'), trigger];
    expect(await maybeTripCircuitBreaker(trigger)).toBe(false);
    expect(state.pauseCalls).toEqual([]);
  });

  it('ignores a successful trigger job', async () => {
    const { maybeTripCircuitBreaker } = await import('@/lib/pipeline/circuit-breaker');
    const ok = mkJob({ id: 'ok', project: 'demo', kind: 'run', exitCode: 0, finishedAt: nowSec() });
    state.jobs = [failure('a'), failure('b'), failure('c'), ok];
    expect(await maybeTripCircuitBreaker(ok)).toBe(false);
    expect(state.pauseCalls).toEqual([]);
  });
});
