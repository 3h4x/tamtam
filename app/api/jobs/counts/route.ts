import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/job-storage';
import { jobNeedsAttention } from '@/lib/jobs/status';

// Lightweight aggregation endpoint. The list endpoint used to serve double
// duty as the source of badge counts ("21,537 entries · 25.3M tok · $385.18"
// at the top of the History tab, plus the tab-bucket counters); doing that
// from the full /api/jobs payload forced every caller that just needed a
// number to pull every row. This endpoint returns only the aggregates.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const project = sp.get('project');

  let jobs = listJobs();
  if (project) jobs = jobs.filter((j) => j.project === project);

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
