import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { jobNeedsAttention } from '@/lib/jobs/status';

function parseEpoch(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Lightweight aggregation endpoint for badge and history summary counts.
// Returns only aggregates so callers do not pull the full /api/jobs payload.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const project = sp.get('project');
  const kind = sp.get('kind');
  const kindPrefix = sp.get('kind_prefix');
  const from = parseEpoch(sp.get('from'));
  const to = parseEpoch(sp.get('to'));

  let jobs = listJobs();
  if (project) jobs = jobs.filter((j) => j.project === project);
  if (kind) jobs = jobs.filter((j) => j.kind === kind);
  if (kindPrefix) jobs = jobs.filter((j) => j.kind.startsWith(kindPrefix));
  if (from !== null) jobs = jobs.filter((j) => j.startedAt >= from);
  if (to !== null) jobs = jobs.filter((j) => j.startedAt <= to);

  const byKind: Record<string, number> = {};
  const byStatus: Record<'running' | 'done' | 'aborted' | 'failed', number> = {
    running: 0,
    done: 0,
    aborted: 0,
    failed: 0,
  };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  let costUsd = 0;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartEpoch = monthStart.getTime() / 1000;
  let monthCostUsd = 0;

  for (const j of jobs) {
    byKind[j.kind] = (byKind[j.kind] ?? 0) + 1;
    if (j.abortedAt != null) byStatus.aborted += 1;
    else if (j.finishedAt === null) byStatus.running += 1;
    else if (jobNeedsAttention(j)) byStatus.failed += 1;
    else byStatus.done += 1;
    inputTokens += j.inputTokens ?? 0;
    outputTokens += j.outputTokens ?? 0;
    cacheReadTokens += j.cacheReadTokens ?? 0;
    cacheCreateTokens += j.cacheCreateTokens ?? 0;
    const c = j.costUsd ?? 0;
    costUsd += c;
    if (j.startedAt >= monthStartEpoch) monthCostUsd += c;
  }

  return NextResponse.json({
    total: jobs.length,
    byKind,
    byStatus,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheCreate: cacheCreateTokens,
      total: inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens,
    },
    cost: {
      total: costUsd,
      monthToDate: monthCostUsd,
    },
  });
}
