import { NextRequest, NextResponse } from 'next/server';
import { listJobs } from '@/lib/jobs/storage';
import { isBoardSyncRateLimitError, syncJobToProjectBoard } from '@/lib/github/project-board';
import { getSettings } from '@/lib/shared/config';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SYNC_DELAY_MS = 250;

export async function POST(request: NextRequest) {
  const settings = getSettings();
  if (!settings.github_board_sync_enabled) {
    return NextResponse.json({ ok: false, error: 'GitHub board sync is disabled.' }, { status: 409 });
  }

  const url = new URL(request.url);
  const daysRaw = Number.parseInt(url.searchParams.get('days') ?? '', 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, MAX_DAYS) : DEFAULT_DAYS;
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  // Only resync release roots and standalone runs (agent / run kinds). Pipeline
  // child jobs (test/review/fix/commit/push/...) are routed to their release
  // root by syncJobToProjectBoard, so syncing them directly would just be
  // redundant queue work — skip them here.
  const childKinds = new Set(['test', 'review', 'fix', 'fix-ci', 'commit', 'push', 'mark-dod', 'pr-wait', 'soak']);
  // Newest jobs first so the budget gets spent on the most recent state.
  const jobs = listJobs()
    .filter((job) => {
      if ((job.startedAt ?? 0) < cutoff) return false;
      if (job.parentJobId) return false;
      if (job.releaseId) return false;
      if (childKinds.has(job.kind)) return false;
      return true;
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, limit);

  let resynced = 0;
  let failed = 0;
  let rateLimited = false;
  let first = true;
  for (const job of jobs) {
    if (!first) await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
    first = false;
    try {
      await syncJobToProjectBoard(job, 'manual', { requireConfigured: true });
      resynced++;
    } catch (error) {
      if (isBoardSyncRateLimitError(error)) {
        rateLimited = true;
        console.error(`[board-resync] stopping early — GitHub rate limit hit after ${resynced} resyncs`);
        break;
      }
      failed++;
      console.error(`[board-resync] failed for ${job.id}`, error);
    }
  }

  return NextResponse.json({
    ok: true,
    days,
    limit,
    scanned: jobs.length,
    resynced,
    failed,
    rateLimited,
  });
}
