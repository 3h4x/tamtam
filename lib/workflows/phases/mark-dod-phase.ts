// Seventh per-phase workflow scaffold: mark-dod (definition-of-done).
//
// Runs inline in the server process — Claude verifies each acceptance
// criterion against the codebase, ticks the verified checkboxes via
// `gh issue edit`, and returns counts. Like push/commit, returns
// synchronously with the full result, so the phase workflow has a single
// 'use step'.
//
// Future iterations dispatch this when the orchestrator decides
// { next: 'mark-dod', from: 'push' } and the release is issue-linked or
// PR-backed. Not wired yet.

import type { MarkDodResult } from '@/lib/pipeline/start-mark-dod';

export type MarkDodPhaseResult =
  | {
      ok: true;
      jobId: string;
      issueNumber: number;
      verified: number;
      total: number;
      changed: boolean;
    }
  | {
      ok: false;
      reason: 'mark_dod_failed';
      status: number;
      detail: string;
    };

export interface MarkDodOverride {
  issueNumber?: number;
  prNumber?: number;
  repo?: string;
}

export async function releaseMarkDodPhaseWorkflow(
  projectName: string,
  override?: MarkDodOverride,
): Promise<MarkDodPhaseResult> {
  'use workflow';
  const r = await markDodStep(projectName, override);
  if (!r.ok) {
    return {
      ok: false,
      reason: 'mark_dod_failed',
      status: r.status,
      detail: r.detail,
    };
  }
  return {
    ok: true,
    jobId: r.jobId,
    issueNumber: r.issueNumber,
    verified: r.verified,
    total: r.total,
    changed: r.changed,
  };
}

async function markDodStep(
  projectName: string,
  override: MarkDodOverride | undefined,
): Promise<MarkDodResult> {
  'use step';
  const { startMarkDod } = await import('@/lib/pipeline/start-mark-dod');
  return startMarkDod(projectName, override);
}
