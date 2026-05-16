import { NextResponse } from 'next/server';
import { runProjectSweep } from '@/lib/jobs/project-sweep-runner';

export async function POST() {
  try {
    const report = await runProjectSweep();
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
