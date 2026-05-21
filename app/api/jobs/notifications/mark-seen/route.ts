import { NextResponse } from 'next/server';
import { markAllUnseenFinished } from '@/lib/jobs/job-storage';

export async function POST() {
  const flipped = await markAllUnseenFinished();
  return NextResponse.json({ status: 'ok', marked: flipped });
}
