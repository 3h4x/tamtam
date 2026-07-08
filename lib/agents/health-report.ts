// Parses the health monitor's machine-readable verdict from its run report,
// persists it on the job's contextMeta (so the inbox can derive a signal from
// it), and surfaces DEGRADED/DOWN as an `app_health` recommendation — HEALTHY
// resolves any open one. Kept out of agent-run-report.ts to respect the
// file-size cap and keep the health-specific logic isolated.

import { upsertRecommendation, resolveRecommendationIfOpen } from '@/lib/recommendations/recommendations';
import type { JobData } from '@/lib/jobs/types';

export type HealthVerdict = 'HEALTHY' | 'DEGRADED' | 'DOWN';

/** Extract the `HEALTH_VERDICT: <verdict> — <reason>` line the agent-health
 *  skill contracts to emit. Returns null when no such line is present. */
export function parseHealthVerdict(text: string): { verdict: HealthVerdict; reason: string } | null {
  const m = text.match(/HEALTH_VERDICT:\s*(HEALTHY|DEGRADED|DOWN)\b[ \t]*[—:-]?[ \t]*(.*)/i);
  if (!m) return null;
  return { verdict: m[1].toUpperCase() as HealthVerdict, reason: (m[2] ?? '').trim() };
}

function mergeVerdictIntoContextMeta(contextMeta: string | null | undefined, verdict: HealthVerdict, reason: string): string {
  let raw: Record<string, unknown> = {};
  try {
    raw = contextMeta ? (JSON.parse(contextMeta) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  raw.healthVerdict = { verdict, reason, at: Date.now() / 1000 };
  return JSON.stringify(raw);
}

/** Persist the run's health verdict on the job and emit/resolve the project's
 *  `app_health` recommendation. An unparseable report is treated as DEGRADED,
 *  never HEALTHY — a health run must never fail silent. Mutates `job.contextMeta`. */
export async function applyHealthVerdict(job: JobData, text: string): Promise<void> {
  const parsed = parseHealthVerdict(text) ?? {
    verdict: 'DEGRADED' as HealthVerdict,
    reason: 'health report missing a HEALTH_VERDICT line',
  };
  job.contextMeta = mergeVerdictIntoContextMeta(job.contextMeta, parsed.verdict, parsed.reason);

  let agentId: string | null = null;
  let agentName = 'health';
  try {
    const cm = job.contextMeta ? (JSON.parse(job.contextMeta) as { agent?: { id?: string; name?: string } }) : {};
    agentId = cm.agent?.id ?? null;
    agentName = cm.agent?.name ?? 'health';
  } catch {
    /* keep defaults */
  }

  if (parsed.verdict === 'HEALTHY') {
    await resolveRecommendationIfOpen(job.project, 'app_health', { agentId, agentName });
    return;
  }

  await upsertRecommendation({
    project: job.project,
    sourceKind: job.kind,
    sourceId: job.id,
    agentId,
    agentName,
    type: 'app_health',
    title: `${job.project} app ${parsed.verdict}`,
    detail: parsed.reason || `Health monitor reports the app is ${parsed.verdict}.`,
    payload: { verdict: parsed.verdict, reason: parsed.reason },
  });
}
