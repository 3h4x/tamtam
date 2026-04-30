import { NextResponse } from 'next/server';
import { unseenFinished, markSeen } from '@/lib/jobs/job-storage';

export async function POST() {
  for (const job of unseenFinished()) {
    markSeen(job.id);
  }
  return NextResponse.json({ status: 'ok' });
}
