import { and, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

export type SpendCapKind = 'daily' | 'release';

export interface SpendCapExceeded {
  ok: false;
  kind: SpendCapKind;
  project: string;
  capUsd: number;
  actualUsd: number;
  releaseId?: string;
  detail: string;
}

export type SpendCapCheck = { ok: true } | SpendCapExceeded;

function normalizeCap(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export async function getProjectDailySpendUsd(projectName: string, nowMs = Date.now()): Promise<number> {
  const sinceSeconds = (nowMs - 24 * 60 * 60 * 1000) / 1000;
  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.jobs.costUsd}), 0)`,
    })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.project, projectName),
      gte(schema.jobs.startedAt, sinceSeconds),
    ));
  return Number(rows[0]?.total ?? 0);
}

async function getProjectSpendCaps(projectName: string): Promise<{
  dailySpendCapUsd: number | null;
  releaseSpendCapUsd: number | null;
} | null> {
  const rows = await db
    .select({
      dailySpendCapUsd: schema.projects.dailySpendCapUsd,
      releaseSpendCapUsd: schema.projects.releaseSpendCapUsd,
    })
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    dailySpendCapUsd: normalizeCap(row.dailySpendCapUsd),
    releaseSpendCapUsd: normalizeCap(row.releaseSpendCapUsd),
  };
}

export async function checkDailySpendCap(projectName: string, nowMs = Date.now()): Promise<SpendCapCheck> {
  const caps = await getProjectSpendCaps(projectName);
  const capUsd = caps?.dailySpendCapUsd ?? null;
  if (capUsd == null) return { ok: true };

  const actualUsd = await getProjectDailySpendUsd(projectName, nowMs);
  if (actualUsd < capUsd) return { ok: true };
  return {
    ok: false,
    kind: 'daily',
    project: projectName,
    capUsd,
    actualUsd,
    detail: `Project daily spend cap exceeded: ${formatUsd(actualUsd)} in the last 24h >= ${formatUsd(capUsd)} cap`,
  };
}

export async function getReleaseSpendUsd(releaseId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${schema.jobs.costUsd}), 0)`,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.releaseId, releaseId));
  return Number(rows[0]?.total ?? 0);
}

export async function checkReleaseSpendCap(projectName: string, releaseId: string): Promise<SpendCapCheck> {
  const caps = await getProjectSpendCaps(projectName);
  const capUsd = caps?.releaseSpendCapUsd ?? null;
  if (capUsd == null) return { ok: true };

  const actualUsd = await getReleaseSpendUsd(releaseId);
  if (actualUsd < capUsd) return { ok: true };
  return {
    ok: false,
    kind: 'release',
    project: projectName,
    releaseId,
    capUsd,
    actualUsd,
    detail: `Release spend cap exceeded: ${formatUsd(actualUsd)} for this release >= ${formatUsd(capUsd)} cap`,
  };
}
