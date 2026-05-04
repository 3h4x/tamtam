import type { JobData } from '@/lib/jobs/types';

export const BOARD_STATUSES = [
  'Todo',
  'In Progress',
  'Review',
  'Fixing',
  'Blocked',
  'Done',
] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

export type BoardSyncPhase = 'started' | 'finished' | 'manual';

export interface BoardTransition {
  status: BoardStatus;
  summary: string;
}

function startedStatus(job: JobData): BoardTransition {
  if (job.kind === 'release') return { status: 'Todo', summary: 'release queued' };
  if (job.kind === 'review') return { status: 'Review', summary: 'review started' };
  if (job.kind === 'fix' || job.kind === 'fix-push' || job.kind === 'fix-ci') {
    return { status: 'Fixing', summary: `${job.kind} started` };
  }
  return { status: 'In Progress', summary: `${job.kind} started` };
}

function finishedStatus(job: JobData): BoardTransition {
  if (job.abortedAt != null) return { status: 'Blocked', summary: `${job.kind} aborted` };
  if (job.kind === 'review') {
    if (job.exitCode !== 0) return { status: 'Blocked', summary: 'review failed' };
    if (job.verdict === 'LGTM') return { status: 'In Progress', summary: 'review passed (LGTM)' };
    if (job.verdict === 'NEEDS ATTENTION') return { status: 'Blocked', summary: 'review needs attention' };
    if (job.verdict === 'DO NOT SHIP') return { status: 'Blocked', summary: 'review blocked (DO NOT SHIP)' };
    return { status: 'Blocked', summary: 'review finished without verdict' };
  }
  if (job.kind === 'test') {
    return job.exitCode === 0
      ? { status: 'In Progress', summary: 'tests passed' }
      : { status: 'Blocked', summary: `tests failed (exit ${job.exitCode ?? 1})` };
  }
  if (job.kind === 'fix' || job.kind === 'fix-push' || job.kind === 'fix-ci') {
    return job.exitCode === 0
      ? { status: 'In Progress', summary: `${job.kind} finished` }
      : { status: 'Blocked', summary: `${job.kind} failed (exit ${job.exitCode ?? 1})` };
  }
  if (job.kind === 'commit') {
    return job.exitCode === 0
      ? { status: 'In Progress', summary: 'commit prepared' }
      : { status: 'Blocked', summary: `commit failed (exit ${job.exitCode ?? 1})` };
  }
  if (job.kind === 'push') {
    return job.exitCode === 0
      ? { status: 'Done', summary: 'push finished' }
      : { status: 'Blocked', summary: `push failed (exit ${job.exitCode ?? 1})` };
  }
  if (job.kind === 'mark-dod' || job.kind === 'pr-wait') {
    return job.exitCode === 0
      ? { status: 'Done', summary: `${job.kind} finished` }
      : { status: 'Blocked', summary: `${job.kind} failed (exit ${job.exitCode ?? 1})` };
  }
  if (job.kind === 'release') {
    return job.exitCode === 0
      ? { status: 'Done', summary: 'release finished' }
      : { status: 'Blocked', summary: `release failed (exit ${job.exitCode ?? 1})` };
  }
  return job.exitCode === 0
    ? { status: 'Done', summary: `${job.kind} finished` }
    : { status: 'Blocked', summary: `${job.kind} failed (exit ${job.exitCode ?? 1})` };
}

export function deriveBoardTransition(job: JobData, phase: BoardSyncPhase): BoardTransition {
  if (phase === 'manual') {
    return job.finishedAt == null ? startedStatus(job) : finishedStatus(job);
  }
  return phase === 'started' ? startedStatus(job) : finishedStatus(job);
}
