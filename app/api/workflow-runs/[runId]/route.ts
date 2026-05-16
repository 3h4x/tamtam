// GET /api/workflow-runs/[runId] — detail for a single workflow run:
// the workflow_runs row + ordered workflow_steps. Useful for debugging
// observation chains (e.g. why did this release's observer choose 'fix'
// instead of 'review'?).
//
// Same pg.Pool strategy as the list endpoint: short-lived module-cached
// pool against WORKFLOW_POSTGRES_URL (falls back to DATABASE_URL). When
// the env var is unset, returns 503.

import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { decodeWorkflowPayload } from '@/lib/workflows/decode-workflow-payload';
import {
  clampJson as clampWorkflowJson,
  readLocalRunFile,
  readLocalStepFiles,
  simplifyWorkflowName,
  toLocalRunSummary,
  toLocalStepSummary,
} from '@/lib/workflows/local-world-runs';

interface RunRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  input: unknown;
  input_cbor: Buffer | null;
  output: unknown;
  output_cbor: Buffer | null;
  error: string | null;
}

interface StepRow {
  step_id: string;
  step_name: string;
  status: string;
  attempt: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  input: unknown;
  input_cbor: Buffer | null;
  output: unknown;
  output_cbor: Buffer | null;
  error: string | null;
}


let cachedPool: Pool | null = null;

function getWorkflowPool(): Pool | null {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  if (!cachedPool) cachedPool = new Pool({ connectionString: url, max: 2 });
  return cachedPool;
}

function simplifyName(raw: string): string {
  return simplifyWorkflowName(raw);
}

function clampJson(value: unknown, maxBytes = 4_000): unknown {
  return clampWorkflowJson(value, maxBytes);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ detail: 'runId required' }, { status: 400 });
  }

  if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
    return readLocalWorldRunDetail(runId);
  }

  const pool = getWorkflowPool();
  if (!pool) {
    return NextResponse.json({ detail: 'WORKFLOW_POSTGRES_URL not set' }, { status: 503 });
  }

  try {
    const runQuery = pool.query<RunRow>(
      `SELECT id, name, status, created_at, started_at, completed_at,
              input, input_cbor, output, output_cbor, error
       FROM workflow.workflow_runs WHERE id = $1`,
      [runId],
    );
    const stepsQuery = pool.query<StepRow>(
      `SELECT step_id, step_name, status, attempt, created_at, started_at, completed_at,
              input, input_cbor, output, output_cbor, error
       FROM workflow.workflow_steps WHERE run_id = $1
       ORDER BY created_at ASC, attempt ASC`,
      [runId],
    );
    const [runResult, stepsResult] = await Promise.all([runQuery, stepsQuery]);
    const run = runResult.rows[0];
    if (!run) {
      return NextResponse.json({ detail: 'workflow run not found' }, { status: 404 });
    }
    return NextResponse.json({
      run: {
        id: run.id,
        name: simplifyName(run.name),
        rawName: run.name,
        status: run.status,
        createdAt: run.created_at.toISOString(),
        startedAt: run.started_at ? run.started_at.toISOString() : null,
        completedAt: run.completed_at ? run.completed_at.toISOString() : null,
        durationMs:
          run.started_at && run.completed_at
            ? run.completed_at.getTime() - run.started_at.getTime()
            : null,
        input: clampJson(decodeWorkflowPayload(run.input, run.input_cbor)),
        output: clampJson(decodeWorkflowPayload(run.output, run.output_cbor)),
        error: run.error,
      },
      steps: stepsResult.rows.map((s) => ({
        stepId: s.step_id,
        name: simplifyName(s.step_name),
        rawName: s.step_name,
        status: s.status,
        attempt: s.attempt,
        createdAt: s.created_at.toISOString(),
        startedAt: s.started_at ? s.started_at.toISOString() : null,
        completedAt: s.completed_at ? s.completed_at.toISOString() : null,
        durationMs:
          s.started_at && s.completed_at
            ? s.completed_at.getTime() - s.started_at.getTime()
            : null,
        input: clampJson(decodeWorkflowPayload(s.input, s.input_cbor)),
        output: clampJson(decodeWorkflowPayload(s.output, s.output_cbor)),
        error: s.error,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { detail: 'workflow query failed', error: (err as Error).message },
      { status: 500 },
    );
  }
}

function readLocalWorldRunDetail(runId: string): NextResponse {
  try {
    const run = readLocalRunFile(runId);
    if (!run) {
      return NextResponse.json({ detail: 'workflow run not found' }, { status: 404 });
    }
    return NextResponse.json({
      run: toLocalRunSummary(run),
      steps: readLocalStepFiles(runId).map(toLocalStepSummary),
    });
  } catch (err) {
    return NextResponse.json(
      { detail: 'failed to read local workflow run', error: (err as Error).message },
      { status: 500 },
    );
  }
}
