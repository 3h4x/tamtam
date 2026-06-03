// Ephemeral per-project reinforce-loop bookkeeping for the release-after-run
// threshold gate. Not durable: a restart resets the loop (worst case one extra
// reinforce cycle). The release itself stays correctly gated because the
// working-tree LOC is recomputed fresh on every decision. Pinned on globalThis
// because Next.js duplicates module instances across route realms.

export interface ReinforceState {
  iterations: number;
  /** Cumulative working-tree LOC observed before the most recent reinforce
   *  dispatch. -1 means "no prior run", so the first sub-threshold run always
   *  counts as progress. */
  lastSeenLoc: number;
}

const g = globalThis as unknown as {
  __tamtamReinforceState?: Map<string, ReinforceState>;
};
function store(): Map<string, ReinforceState> {
  if (!g.__tamtamReinforceState) g.__tamtamReinforceState = new Map();
  return g.__tamtamReinforceState;
}

export function getReinforceState(project: string): ReinforceState {
  return store().get(project) ?? { iterations: 0, lastSeenLoc: -1 };
}

export function bumpReinforceState(project: string, loc: number): void {
  const cur = getReinforceState(project);
  store().set(project, { iterations: cur.iterations + 1, lastSeenLoc: loc });
}

export function clearReinforceState(project: string): void {
  store().delete(project);
}

/** Resolve the agent id for a finished job row. JobData does not surface it,
 *  but agent runs store invocation metadata in jobs.context_meta. Returns null
 *  for non-agent rows, legacy rows without metadata, or malformed metadata. */
export async function getJobAgentId(jobId: string): Promise<string | null> {
  const { db, schema } = await import('@/lib/db');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select({ contextMeta: schema.jobs.contextMeta })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  const rawMeta = rows[0]?.contextMeta;
  if (!rawMeta) return null;
  try {
    const parsed = JSON.parse(rawMeta) as { agent?: { id?: unknown } };
    return typeof parsed.agent?.id === 'string' ? parsed.agent.id : null;
  } catch {
    return null;
  }
}

/** Re-dispatch the finished agent to keep working, via the same internal
 *  /run path cron uses. Returns true when the run was accepted (HTTP 2xx,
 *  not a 202 queue). On any non-2xx / 202 the caller should clear state and
 *  release whatever exists, so a broken re-dispatch can't strand the work. */
export async function redispatchAgentForReinforce(
  agentId: string,
  project: string,
  augmentedPrompt: string,
): Promise<boolean> {
  const baseUrl = process.env.TAMTAM_BASE_URL ?? 'http://localhost:1337';
  try {
    const res = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tamtam-trigger': 'schedule' },
      body: JSON.stringify({ prompt: augmentedPrompt }),
    });
    if (res.status === 202) {
      console.log(`[reinforce] re-dispatch queued for ${project} (agent ${agentId})`);
      return false;
    }
    if (!res.ok) {
      console.warn(`[reinforce] re-dispatch for ${project} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[reinforce] re-dispatch for ${project} failed:`, err);
    return false;
  }
}

/** The nudge prompt that stands in as the task for a reinforce run. */
export function buildReinforcePrompt(currentLoc: number): string {
  return [
    `Your previous run changed only ${currentLoc} lines — too small to justify a release.`,
    'Continue improving this work: add tests, handle edge cases, harden error paths,',
    'or refactor adjacent code, until the change is substantial. Do not stop at a trivial edit.',
  ].join(' ');
}
