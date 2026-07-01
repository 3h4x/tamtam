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

/** Pure: pick the best file agent to carry an initiative's prompt — an enabled,
 *  non-system, producer-role agent, preferring one named `improve` (the canonical
 *  code agent). Returns its `file:project:name` id, or null if none qualifies. */
export function pickFileAgentForInitiative(
  fileAgents: Array<{ id: string; name: string; enabled: boolean; kind: string; role: string }>,
): string | null {
  const eligible = fileAgents.filter((a) => a.enabled && a.kind !== 'system' && a.role === 'producer');
  if (eligible.length === 0) return null;
  return (eligible.find((a) => a.name === 'improve') ?? eligible[0]).id;
}

// A busy/locked agent-run response is transient — the project (or the chosen
// agent) is already running something. Mapping it to a re-queue lets the
// dispatcher retry on a short cooldown instead of burning the initiative on a
// 6-hour hard-failure. 409 = agent already running / duplicate; 423 = locked;
// 429 = rate/budget; 503 = unavailable.
const BUSY_RUN_STATUSES = new Set([409, 423, 429, 503]);

/** Pure: classify an agent-run HTTP status — busy ⇒ transient re-queue, else null (caller throws). */
export function busyRunResult(status: number, bodyText: string): InitiativeRunStartResult | null {
  if (BUSY_RUN_STATUSES.has(status)) {
    return { status: 'queued', detail: bodyText.slice(0, 200) || `HTTP ${status} busy` };
  }
  return null;
}

export interface RunInitiativeDeps {
  startRun: (args: { project: string; prompt: string }) => Promise<InitiativeRunStartResult>;
}

async function defaultStartRun(args: { project: string; prompt: string }): Promise<InitiativeRunStartResult> {
  const { db, schema } = await import('@/lib/db');
  const { eq, and } = await import('drizzle-orm');

  // Find enabled, non-system agents for this project. System agents dispatch
  // to internal handlers — only user agents spawn a CLI run whose diff flows
  // into the release pipeline. Prefer a producer-role agent (named `improve`
  // when present) via pickFileAgentForInitiative.
  const agents = await db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      enabled: schema.agents.enabled,
      kind: schema.agents.kind,
      role: schema.agents.role,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.project, args.project),
        eq(schema.agents.enabled, true),
        eq(schema.agents.kind, 'user'),
      ),
    );

  const agentId: string | null =
    pickFileAgentForInitiative(agents.map((a) => ({ ...a, enabled: !!a.enabled }))) ??
    (agents[0]?.id ?? null);
  if (!agentId) {
    throw new Error(
      `[run-initiative] no enabled producer agent found for project "${args.project}" — ` +
      `add at least one agent before dispatching initiatives`,
    );
  }

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
    // A busy/locked project is transient — re-queue (short cooldown) instead of
    // burning the initiative on a 6h hard-failure.
    const busy = busyRunResult(res.status, body);
    if (busy) return busy;
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
