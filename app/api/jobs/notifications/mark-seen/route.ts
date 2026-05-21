import { NextResponse } from 'next/server';
import { markAllUnseenFinished } from '@/lib/jobs/job-storage';

export async function POST() {
  // Single targeted UPDATE + cache flip instead of N upserts (one per
  // matching job row) — the prior per-row loop scaled linearly with the
  // unseen-finished backlog and made the notifications badge clear feel
  // sluggish when a release wave dumped many completions at once.
  const flipped = await markAllUnseenFinished();
  return NextResponse.json({ status: 'ok', marked: flipped });
}
