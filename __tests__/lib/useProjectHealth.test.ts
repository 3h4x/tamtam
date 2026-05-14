import { describe, it, expect } from 'vitest';
import { computeFleetHealth } from '@/hooks/useProjectHealth';
import type { Task } from '@/lib/shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project: 'proj',
    job: null,
    priority: null,
    paused: false,
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

describe('computeFleetHealth', () => {
  it('returns empty fleet for no tasks', () => {
    const fleet = computeFleetHealth([]);
    expect(fleet.projects).toHaveLength(0);
    expect(fleet.errorCount).toBe(0);
    expect(fleet.warningCount).toBe(0);
    expect(fleet.healthyCount).toBe(0);
    expect(fleet.unknownCount).toBe(0);
    expect(fleet.totalTasks).toBe(0);
    expect(fleet.totalChanges).toBe(0);
    expect(fleet.totalUnreviewed).toBe(0);
  });

  describe('task health status', () => {
    it('marks task as error when exit code > 0', () => {
      const fleet = computeFleetHealth([makeTask({ last_run_exit: 1, last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('error');
      expect(fleet.errorCount).toBe(1);
    });

    it('does not mark project status as error on CI failure (CI has its own column)', () => {
      const fleet = computeFleetHealth([makeTask({ ci: 'failure', last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('healthy');
    });

    it('exit code error remains error even with CI failure', () => {
      const fleet = computeFleetHealth([makeTask({ last_run_exit: 2, ci: 'failure', last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('error');
    });

    it('marks task as warning when paused', () => {
      const fleet = computeFleetHealth([makeTask({ paused: true, last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('warning');
      expect(fleet.warningCount).toBe(1);
    });

    it('marks task as warning when changes unreviewed', () => {
      const fleet = computeFleetHealth([makeTask({ changes: 3, reviewed: false, last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('warning');
    });

    it('does not warn about unreviewed when changes = 0', () => {
      const fleet = computeFleetHealth([makeTask({ changes: 0, reviewed: false, last_run: '2024-01-01', last_run_ago: '5m' })]);
      expect(fleet.projects[0].status).toBe('healthy');
    });

    it('marks critical task as warning when stale (>24h)', () => {
      const fleet = computeFleetHealth([makeTask({ priority: 'critical', last_run_ago: '25h' })]);
      expect(fleet.projects[0].status).toBe('warning');
    });

    it('marks high priority task as warning when stale (>24h)', () => {
      const fleet = computeFleetHealth([makeTask({ priority: 'high', last_run_ago: '2d' })]);
      expect(fleet.projects[0].status).toBe('warning');
    });

    it('does not warn about stale for medium priority', () => {
      const fleet = computeFleetHealth([makeTask({ priority: 'medium', last_run: '2024-01-01', last_run_ago: '25h' })]);
      expect(fleet.projects[0].status).toBe('healthy');
    });

    it('does not warn about stale at exactly 24h', () => {
      const fleet = computeFleetHealth([makeTask({ priority: 'critical', last_run: '2024-01-01', last_run_ago: '24h' })]);
      expect(fleet.projects[0].status).toBe('healthy');
    });

    it('marks task as unknown when no run and no CI data', () => {
      const fleet = computeFleetHealth([makeTask({ last_run: null, last_run_ago: null, ci: null })]);
      expect(fleet.projects[0].status).toBe('unknown');
      expect(fleet.unknownCount).toBe(1);
    });

    it('is healthy with run data and no issues', () => {
      const fleet = computeFleetHealth([makeTask({ last_run: '2024-01-01', last_run_ago: '5m', last_run_exit: 0 })]);
      expect(fleet.projects[0].status).toBe('healthy');
      expect(fleet.healthyCount).toBe(1);
    });

    it('error takes precedence over warning conditions', () => {
      const fleet = computeFleetHealth([
        makeTask({ last_run_exit: 1, paused: true, sync: false, last_run_ago: '5m' }),
      ]);
      expect(fleet.projects[0].status).toBe('error');
    });
  });

  describe('project grouping', () => {
    it('groups tasks from the same project', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha', job: 'job-a' }),
        makeTask({ id: 't2', project: 'alpha', job: 'job-b' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects).toHaveLength(1);
      expect(fleet.projects[0].tasks).toHaveLength(2);
      expect(fleet.totalTasks).toBe(2);
    });

    it('creates separate projects for different project names', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha' }),
        makeTask({ id: 't2', project: 'beta' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects).toHaveLength(2);
    });

    it('uses worst status across tasks in a project', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha', last_run_ago: '5m' }),
        makeTask({ id: 't2', project: 'alpha', last_run_exit: 1, last_run_ago: '5m' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects[0].status).toBe('error');
    });

    it('aggregates totalChanges from first task of each project', () => {
      const tasks = [makeTask({ project: 'alpha', changes: 5 })];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects[0].totalChanges).toBe(5);
      expect(fleet.totalChanges).toBe(5);
    });

    it('counts unreviewed projects', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha', changes: 3, reviewed: false }),
        makeTask({ id: 't2', project: 'beta', changes: 0 }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.totalUnreviewed).toBe(1);
    });
  });

  describe('sort order', () => {
    it('sorts errors before warnings before healthy', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'healthy-proj', last_run_ago: '5m' }),
        makeTask({ id: 't2', project: 'error-proj', last_run_exit: 1, last_run_ago: '5m' }),
        makeTask({ id: 't3', project: 'warn-proj', paused: true, last_run_ago: '5m' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects[0].project).toBe('error-proj');
      expect(fleet.projects[1].project).toBe('warn-proj');
      expect(fleet.projects[2].project).toBe('healthy-proj');
    });

    it('sorts alphabetically within the same status', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'zebra', last_run_ago: '5m' }),
        makeTask({ id: 't2', project: 'alpha', last_run_ago: '5m' }),
        makeTask({ id: 't3', project: 'mango', last_run_ago: '5m' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects.map(p => p.project)).toEqual(['alpha', 'mango', 'zebra']);
    });
  });

  describe('lastRunAgo', () => {
    it('picks the most recent last_run_ago among tasks', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha', last_run_ago: '2h' }),
        makeTask({ id: 't2', project: 'alpha', last_run_ago: '30m' }),
        makeTask({ id: 't3', project: 'alpha', last_run_ago: '1d' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects[0].lastRunAgo).toBe('30m');
    });

    it('handles <1m as most recent', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'alpha', last_run_ago: '5m' }),
        makeTask({ id: 't2', project: 'alpha', last_run_ago: '<1m' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.projects[0].lastRunAgo).toBe('<1m');
    });

    it('returns null when no task has run data', () => {
      const fleet = computeFleetHealth([makeTask({ last_run_ago: null })]);
      expect(fleet.projects[0].lastRunAgo).toBeNull();
    });
  });

  describe('fleet counters', () => {
    it('counts multiple project statuses correctly', () => {
      const tasks = [
        makeTask({ id: 't1', project: 'e1', last_run_exit: 1, last_run_ago: '5m' }),
        makeTask({ id: 't2', project: 'e2', last_run_exit: 1, last_run_ago: '5m' }),
        makeTask({ id: 't3', project: 'w1', paused: true, last_run_ago: '5m' }),
        makeTask({ id: 't4', project: 'h1', last_run: '2024-01-01', last_run_ago: '5m' }),
        makeTask({ id: 't5', project: 'u1' }),
      ];
      const fleet = computeFleetHealth(tasks);
      expect(fleet.errorCount).toBe(2);
      expect(fleet.warningCount).toBe(1);
      expect(fleet.healthyCount).toBe(1);
      expect(fleet.unknownCount).toBe(1);
    });
  });
});
