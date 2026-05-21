// POST /api/jobs/[jobId]/replay-actions — re-run the agent action orchestrator
// for a completed agent job.
//
// Idempotent by design: each action helper short-circuits when the target
// state is already reached (issue already closed, branch already on default,
// label already applied, ...) so replaying is safe whether or not the
// original execution happened. Persists the resulting `agentActions` counts
// on the job's contextMeta so the UI surfaces the recovered work.

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { getJob, updateJob } from '@/lib/jobs/job-storage';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { extractAssistantTextFromRawLog } from '@/lib/agents/work-summary-extractor.mjs';
import { parseAgentActions } from '@/lib/agents/action-block-parser';
import { canExecuteAgentActions } from '@/lib/agents/action-eligibility';
import { runAgentActions } from '@/lib/agents/action-orchestrator';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ detail: 'job not found' }, { status: 404 });
  }
  if (!job.logPath) {
    return NextResponse.json({ detail: 'job has no log path; cannot replay actions' }, { status: 400 });
  }
  if (job.finishedAt == null) {
    return NextResponse.json({ detail: 'job is still running' }, { status: 409 });
  }
  const projPath = resolveProjectPath(job.project);
  if (!projPath) {
    return NextResponse.json({ detail: `project '${job.project}' not found` }, { status: 404 });
  }

  let rawLog = '';
  try {
    rawLog = await readFile(/*turbopackIgnore: true*/ job.logPath, 'utf8');
  } catch (err) {
    return NextResponse.json(
      { detail: 'failed to read job log', error: (err as Error).message },
      { status: 500 },
    );
  }
  const text = extractAssistantTextFromRawLog(rawLog);
  const parsed = parseAgentActions(text);
  if (!parsed.ok) {
    return NextResponse.json({
      replayed: false,
      reason: parsed.reason,
      detail: parsed.detail ?? null,
    }, { status: 200 });
  }
  if (parsed.actions.length === 0) {
    return NextResponse.json({ replayed: false, reason: 'no-actions' }, { status: 200 });
  }
  const eligibility = canExecuteAgentActions(job, parsed.actions);
  if (!eligibility.ok) {
    return NextResponse.json({
      replayed: false,
      reason: eligibility.reason,
      detail: eligibility.detail ?? null,
    }, { status: 409 });
  }

  const result = await runAgentActions({
    project: job.project,
    projPath,
    jobId: job.id,
    actions: parsed.actions,
  });

  // Mirror the live-hook behavior: stash result counts on contextMeta so the
  // UI can show "closed issue #N" alongside the verdict without re-parsing.
  try {
    const meta = JSON.parse(job.contextMeta || '{}');
    meta.agentActions = {
      executed: result.executed,
      errors: result.errors,
      replayedAt: Date.now(),
    };
    job.contextMeta = JSON.stringify(meta);
    updateJob(job);
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({
    replayed: true,
    executed: result.executed,
    errors: result.errors,
  });
}
