import { describe, it, expect } from 'vitest';
import { getAggregateCi, getCiFailedUrl, getReleaseTag, formatDuration } from '@/lib/shared/statusConstants';
import type { ProjectHealth } from '@/hooks/useProjectHealth';
import type { Task } from '@/lib/shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project: 'proj',
    job: null,
    priority: null,
    launchctl: 'running',
    path: '/tmp/proj',
    fires_at: '',
    sync: null,
    changes: 0,
    unpushed: 0,
    reviewed: null,
    last_run: null,
    last_run_ago: null,
    last_run_duration_s: null,
    last_run_exit: null,
    release_tag: null,
    ci: null,
    ci_failed_url: null,
    github: null,
    ...overrides,
  };
}

function makeHealth(tasks: Task[]): ProjectHealth {
  return {
    project: 'proj',
    status: 'healthy',
    tasks: tasks.map((t) => ({ task: t, status: 'healthy', summary: '' })),
    totalChanges: 0,
    unpushed: 0,
    unreviewedCount: 0,
    lastRunAgo: null,
  };
}

describe('getAggregateCi', () => {
  it('returns null when no tasks have CI', () => {
    expect(getAggregateCi(makeHealth([makeTask()]))).toBeNull();
  });

  it('returns null when tasks array is empty', () => {
    expect(getAggregateCi(makeHealth([]))).toBeNull();
  });

  it('returns success when all CIs are success', () => {
    const h = makeHealth([makeTask({ ci: 'success' }), makeTask({ ci: 'success' })]);
    expect(getAggregateCi(h)).toBe('success');
  });

  it('returns failure when any CI is failure', () => {
    const h = makeHealth([makeTask({ ci: 'success' }), makeTask({ ci: 'failure' })]);
    expect(getAggregateCi(h)).toBe('failure');
  });

  it('failure takes precedence over in_progress', () => {
    const h = makeHealth([makeTask({ ci: 'in_progress' }), makeTask({ ci: 'failure' })]);
    expect(getAggregateCi(h)).toBe('failure');
  });

  it('returns in_progress when no failure but some in_progress', () => {
    const h = makeHealth([makeTask({ ci: 'success' }), makeTask({ ci: 'in_progress' })]);
    expect(getAggregateCi(h)).toBe('in_progress');
  });
});

describe('getCiFailedUrl', () => {
  it('returns null when no task has a failed URL', () => {
    expect(getCiFailedUrl(makeHealth([makeTask()]))).toBeNull();
  });

  it('returns the first ci_failed_url found', () => {
    const h = makeHealth([
      makeTask({ ci_failed_url: null }),
      makeTask({ ci_failed_url: 'https://example.com/run/1' }),
      makeTask({ ci_failed_url: 'https://example.com/run/2' }),
    ]);
    expect(getCiFailedUrl(h)).toBe('https://example.com/run/1');
  });

  it('skips null entries and returns first non-null', () => {
    const h = makeHealth([
      makeTask({ ci_failed_url: null }),
      makeTask({ ci_failed_url: 'https://example.com/run/42' }),
    ]);
    expect(getCiFailedUrl(h)).toBe('https://example.com/run/42');
  });
});

describe('getReleaseTag', () => {
  it('returns null when no task has a release tag', () => {
    expect(getReleaseTag(makeHealth([makeTask()]))).toBeNull();
  });

  it('returns the first release_tag found', () => {
    const h = makeHealth([
      makeTask({ release_tag: null }),
      makeTask({ release_tag: 'v1.2.3' }),
      makeTask({ release_tag: 'v1.2.4' }),
    ]);
    expect(getReleaseTag(h)).toBe('v1.2.3');
  });
});

describe('formatDuration', () => {
  it('formats seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(1)).toBe('1s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('formats exact minutes', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(120)).toBe('2m');
  });

  it('formats minutes with remaining seconds', () => {
    expect(formatDuration(61)).toBe('1m 1s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(150)).toBe('2m 30s');
  });
});
