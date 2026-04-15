import { NextResponse } from 'next/server';
import { unseenFinished, jobToDict } from '@/lib/job-storage';

export async function GET() {
  const jobs = unseenFinished();
  return NextResponse.json({
    count: jobs.length,
    jobs: jobs.map(jobToDict),
  });
}
