// GET /api/workflow-runs — recent rows from the Vercel Workflow Postgres
// World. Surfaces the workflow_runs table so the observation chain
// (lib/workflows/release.ts) is visible without psql.
//
// The Workflow DB is typically a separate Postgres database from the
// main TamTam DB (WORKFLOW_POSTGRES_URL vs DATABASE_URL), so this route
// opens its own short-lived pg.Pool. When the env var is unset, returns
// an empty list rather than failing — the app boots fine without
// Workflow enabled.

import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { decodeWorkflowPayload } from '@/lib/workflows/decode-workflow-payload';

interface WorkflowRunRow {
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

let cachedPool: Pool | null = null;

function getWorkflowPool(): Pool | null {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  if (!cachedPool) {
    cachedPool = new Pool({ connectionString: url, max: 2 });
  }
  return cachedPool;
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  const pool = getWorkflowPool();
  if (!pool) {
    return NextResponse.json({
      runs: [],
      reason: 'WORKFLOW_POSTGRES_URL not set',
      meta: buildMeta(),
    });
  }

  try {
    const { rows } = await pool.query<WorkflowRunRow>(
      `SELECT id, name, status, created_at, started_at, completed_at,
              input, input_cbor, output, output_cbor, error
       FROM workflow.workflow_runs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return NextResponse.json({
      meta: buildMeta(),
      runs: rows.map((r) => ({
        id: r.id,
        // Strip the loader's "workflow//./lib/…//fnName" mangling for readability.
        name: simplifyName(r.name),
        rawName: r.name,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        startedAt: r.started_at ? r.started_at.toISOString() : null,
        completedAt: r.completed_at ? r.completed_at.toISOString() : null,
        durationMs:
          r.started_at && r.completed_at
            ? r.completed_at.getTime() - r.started_at.getTime()
            : null,
        // Surface input args so operators can see what each run was invoked
        // with. Most workflow runs take (projectName, ...) as args so the
        // first element is the most useful at-a-glance signal.
        input: clampJson(decodeWorkflowPayload(r.input, r.input_cbor)),
        // Keep output small in the API response — full payload via a per-run
        // detail endpoint if/when needed.
        output: clampJson(decodeWorkflowPayload(r.output, r.output_cbor)),
        error: r.error,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { runs: [], reason: 'workflow query failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}

// "workflow//./lib/workflows/release//releaseObservationWorkflow" → "releaseObservationWorkflow"
// Surfaces the workflow env-flag state so the /workflow-runs UI can show
// whether the orchestrator is actually driving releases or just observing.
// All three signals here come from process.env so they reflect the boot-time
// config — toggling `.env.local` and restarting is the canonical way to
// change them.
function buildMeta() {
  const workflowEnabled = process.env.WORKFLOW_TARGET_WORLD != null && process.env.WORKFLOW_TARGET_WORLD.length > 0;
  const releaseWorkflow = process.env.TAMTAM_RELEASE_WORKFLOW === '1';
  const releaseWorkflowDrive = process.env.TAMTAM_RELEASE_WORKFLOW_DRIVE === '1';
  let mode: 'disabled' | 'observation_only' | 'drive';
  if (!releaseWorkflow) mode = 'disabled';
  else if (!releaseWorkflowDrive) mode = 'observation_only';
  else mode = 'drive';
  return {
    workflowEnabled,
    releaseWorkflow,
    releaseWorkflowDrive,
    mode,
  };
}

function simplifyName(raw: string): string {
  const parts = raw.split('//');
  return parts[parts.length - 1] || raw;
}

function clampJson(value: unknown, maxBytes = 2_000): unknown {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= maxBytes) return value;
  return { _truncated: true, preview: s.slice(0, maxBytes), originalBytes: s.length };
}
