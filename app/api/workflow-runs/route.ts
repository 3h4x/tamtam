// GET /api/workflow-runs — recent rows from the Vercel Workflow Postgres
// World. Surfaces the workflow_runs table so the observation chain
// (lib/workflows/release.ts) is visible without psql.
//
// The Workflow DB is typically a separate Postgres database from the
// main TamTam DB (WORKFLOW_POSTGRES_URL vs DATABASE_URL), so this route
// opens its own pg.Pool cached on globalThis (Next.js duplicates modules
// across realms — globalThis prevents one pool per realm). When the env
// var is unset, returns an empty list rather than failing — the app
// boots fine without Workflow enabled.

import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { decodeWorkflowPayload } from '@/lib/workflows/decode-workflow-payload';
import {
  clampJson,
  listLocalRunFilesNewestFirst,
  localWorldRunsDir,
  normalizeWorkflowError,
  readLocalRunFile,
  simplifyWorkflowName,
  toLocalRunSummary,
} from '@/lib/workflows/local-world-runs';
import { existsSync } from 'fs';

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
  // The Workflow Postgres `error` column is `jsonb`, so node-pg auto-parses
  // it into a JS value — a string for legacy rows, but typically an object
  // like `{message, stack}` for structured failures. Both shapes appear in
  // the wild; the API normalizes to a string before serving so the client
  // can render it directly without per-row type-guarding.
  error: unknown;
}


declare global {
  var __tamtamWorkflowRunsPool: Pool | undefined;
}

function getWorkflowPool(): Pool | null {
  const url = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  if (!globalThis.__tamtamWorkflowRunsPool) {
    globalThis.__tamtamWorkflowRunsPool = new Pool({ connectionString: url, max: 2 });
  }
  return globalThis.__tamtamWorkflowRunsPool;
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  // When the workflow runtime is using its file-backed local world, the
  // Postgres workflow.workflow_runs table is empty by design — runs live
  // as JSON files under data/workflow-data/runs/. Read those instead so
  // the /workflow-runs UI shows current state regardless of world choice.
  if (process.env.WORKFLOW_TARGET_WORLD === 'local') {
    return readLocalWorldRuns(limit);
  }

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
        name: simplifyWorkflowName(r.name),
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
        error: normalizeWorkflowError(r.error),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        runs: [],
        reason: 'workflow query failed',
        detail: (err as Error).message,
        meta: buildMeta(),
      },
      { status: 500 },
    );
  }
}

// Surfaces the workflow runtime state for the /workflow-runs UI. Drive mode
// is the only release path now; the observation-only fallback and the
// `TAMTAM_RELEASE_WORKFLOW_DRIVE` env gate were retired with the legacy
// reconciler. Response shape preserved for existing UI consumers.
function buildMeta() {
  const workflowEnabled = process.env.WORKFLOW_TARGET_WORLD != null && process.env.WORKFLOW_TARGET_WORLD.length > 0;
  return {
    workflowEnabled,
    releaseWorkflow: true,
    releaseWorkflowDrive: true,
    mode: 'drive' as const,
  };
}

function readLocalWorldRuns(limit: number): NextResponse {
  const dir = localWorldRunsDir();
  if (!existsSync(/*turbopackIgnore: true*/ dir)) {
    return NextResponse.json({
      runs: [],
      reason: `local world runs dir not found: ${dir}`,
      meta: buildMeta(),
    });
  }
  let slice: Array<{ name: string; mtime: number }>;
  try {
    slice = listLocalRunFilesNewestFirst(limit);
  } catch (err) {
    return NextResponse.json(
      {
        runs: [],
        reason: 'failed to list local runs',
        detail: (err as Error).message,
        meta: buildMeta(),
      },
      { status: 500 },
    );
  }

  const runs = slice.map(({ name }) => {
    try {
      const raw = readLocalRunFile(name.replace(/\.json$/, ''));
      if (!raw) throw new Error('run file disappeared while reading');
      return toLocalRunSummary(raw);
    } catch (err) {
      return {
        id: name.replace(/\.json$/, ''),
        name: 'unreadable',
        rawName: '',
        status: 'unknown',
        createdAt: new Date(0).toISOString(),
        startedAt: null,
        completedAt: null,
        durationMs: null,
        input: null,
        output: null,
        error: `read failed: ${(err as Error).message}`,
      };
    }
  });

  // Local-world files don't carry a reliable createdAt ordering across
  // mtimes if the file was rewritten on completion. Resort by createdAt
  // (newest first) for the final response — falls back to mtime order.
  runs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));

  return NextResponse.json({
    meta: buildMeta(),
    runs,
  });
}
