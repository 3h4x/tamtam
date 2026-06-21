// Starts a one-shot in-process agent run carrying an initiative's prompt so
// the produced diff flows into the existing release-after-run / auto-push
// pipeline. The real wiring (defaultStartRun) finds the project's first
// enabled user-role agent and fires it via the internal /run endpoint — the
// same path the cron scheduler and reinforce loop use.
//
// The injected `deps.startRun` seam exists purely for unit tests: tests inject
// a fake so no agent or HTTP server is needed.

import type { InitiativeRow } from '@/lib/orchestrator/initiatives-store';

export type InitiativeRunStartResult =
  | { status: 'started'; jobId: string }
  | { status: 'queued'; detail: string | null };

export function extractJobId(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const v = o.job_id ?? o.jobId; // endpoint returns snake_case job_id; tolerate camelCase too
  // Only a non-empty string is a real job id. Reject numbers/booleans/etc. so a
  // malformed response can't coerce (e.g. 0 → "0") into a truthy fake id.
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function extractRunStartResult(json: unknown): InitiativeRunStartResult | null {
  const jobId = extractJobId(json);
  if (jobId) return { status: 'started', jobId };
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.status === 'queued' || o.status === 'skipped') {
    return {
      status: 'queued',
      detail: typeof o.detail === 'string' ? o.detail : null,
    };
  }
  return null;
}

export interface RunInitiativeDeps {
  startRun: (args: { project: string; prompt: string }) => Promise<InitiativeRunStartResult>;
}

async function defaultStartRun(args: { project: string; prompt: string }): Promise<InitiativeRunStartResult> {
  const { db, schema } = await import('@/lib/db');
  const { eq, and } = await import('drizzle-orm');

  // Find the first enabled, non-system agent for this project. System agents
  // dispatch to internal handlers — only user agents spawn a CLI run whose diff
  // flows into the release pipeline.
  const agents = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.project, args.project),
        eq(schema.agents.enabled, true),
        eq(schema.agents.kind, 'user'),
      ),
    )
    .limit(1);

  if (agents.length === 0) {
    throw new Error(
      `[run-initiative] no enabled user agent found for project "${args.project}" — ` +
      `add at least one agent before enabling the initiative engine`,
    );
  }

  const agentId = agents[0].id;
  const port = process.env.PORT ?? '1337';
  const baseUrl = process.env.TAMTAM_BASE_URL ?? `http://localhost:${port}`;
  const url = `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/run`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tamtam-trigger': 'initiative' },
    body: JSON.stringify({ prompt: args.prompt }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[run-initiative] agent run request for project "${args.project}" failed: ` +
      `HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }

  const json: unknown = await res.json();
  const result = extractRunStartResult(json);
  if (!result) throw new Error('[run-initiative] agent run response had no job_id');
  return result;
}

export async function startInitiativeRun(
  project: string,
  row: InitiativeRow,
  deps: RunInitiativeDeps = { startRun: defaultStartRun },
): Promise<InitiativeRunStartResult> {
  return deps.startRun({ project, prompt: row.prompt });
}
