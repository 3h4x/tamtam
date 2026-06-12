import { NextRequest, NextResponse } from 'next/server';
import { getQueuedTerminalRun, cancelQueuedTerminalRun } from '@/lib/terminal/pending-terminal-run';

// Status of a queued terminal run. The originating terminal polls this until
// `status: 'started'`, then attaches the live stream to the returned jobId.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string; queueId: string }> },
) {
  const { projectName, queueId } = await params;
  const entry = await getQueuedTerminalRun(queueId);
  if (!entry || entry.project !== projectName) {
    // Drained-and-pruned or never existed: report a terminal state so the
    // poller stops cleanly rather than spinning forever.
    return NextResponse.json({ status: 'gone', jobId: null });
  }
  return NextResponse.json({ status: entry.status, jobId: entry.startedJobId });
}

// Cancel a still-pending queued run.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string; queueId: string }> },
) {
  const { projectName, queueId } = await params;
  const entry = await getQueuedTerminalRun(queueId);
  if (entry && entry.project !== projectName) {
    return NextResponse.json({ detail: 'not found' }, { status: 404 });
  }
  const cancelled = await cancelQueuedTerminalRun(queueId);
  return NextResponse.json({ cancelled });
}
