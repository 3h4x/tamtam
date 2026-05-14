// Marks release jobs as "workflow-driven" so the completion-hook chain in
// lib/jobs/lifecycle.ts knows to skip downstream dispatch — otherwise hooks
// AND the orchestrator workflow would both fire follow-on steps and we'd
// double-dispatch. The marker lives in the release meta-job's contextMeta
// as `{ workflowDriven: true }` alongside the existing fields (issueNumber,
// prNumber, releaseStopReason, etc.).
//
// The helpers don't mutate behavior on their own — they're the
// pre-condition for the future wiring step. lifecycle.ts continues to run
// hooks unconditionally until that step lands.
//
// Lookup rule: for non-release jobs, follow the releaseId to the release
// meta-job and read its flag. A workflow-driven release stamps the marker
// on the meta-job once at startup; every child step inherits that
// orchestration ownership.

import type { JobData } from '@/lib/jobs/types';

const WORKFLOW_DRIVEN_KEY = 'workflowDriven';

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Stamp the workflowDriven flag on the release meta-job's contextMeta.
 *  Idempotent: a no-op if already stamped. Returns the updated meta. */
export function markReleaseWorkflowDriven(release: JobData): Record<string, unknown> {
  const meta = parseJsonObject(release.contextMeta);
  if (meta[WORKFLOW_DRIVEN_KEY] === true) return meta;
  meta[WORKFLOW_DRIVEN_KEY] = true;
  release.contextMeta = JSON.stringify(meta);
  return meta;
}

/** Returns true if the job (or its release parent) has been marked as
 *  workflow-driven. For release-kind jobs, checks contextMeta directly.
 *  For sub-step jobs, looks up the release meta-job via releaseId. */
export function isWorkflowDriven(
  job: JobData,
  lookupRelease: (id: string) => JobData | null,
): boolean {
  if (job.kind === 'release') {
    const meta = parseJsonObject(job.contextMeta);
    return meta[WORKFLOW_DRIVEN_KEY] === true;
  }
  if (!job.releaseId) return false;
  const release = lookupRelease(job.releaseId);
  if (!release) return false;
  const meta = parseJsonObject(release.contextMeta);
  return meta[WORKFLOW_DRIVEN_KEY] === true;
}
