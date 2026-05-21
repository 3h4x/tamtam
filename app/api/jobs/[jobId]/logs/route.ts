import { NextRequest, NextResponse } from 'next/server';
import { readJobLogs } from '@/lib/jobs/log-persistence';
import { errMsg } from '@/lib/shared/types';

// Reject anything outside the alphabet TamTam actually emits for jobIds.
// `createJob` builds IDs as `<project>-<kind>-<timestamp>`, where kinds can
// include `:` (e.g. `agent:audit-logs-...`). The strict allow-list below is
// a superset of every observed valid jobId and forbids the path-traversal
// payloads (`/`, `\`, `..`, control chars, etc.) that would otherwise let
// the request read `.log` files outside `~/.tamtam/jobs/`.
const VALID_JOB_ID = /^[A-Za-z0-9._:-]+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  if (!VALID_JOB_ID.test(jobId)) {
    return NextResponse.json({ logs: null, error: 'invalid jobId' }, { status: 400 });
  }
  try {
    const frames = readJobLogs(jobId);
    return NextResponse.json({ logs: frames, count: frames.length });
  } catch (e: unknown) {
    return NextResponse.json({ logs: null, error: errMsg(e) });
  }
}
