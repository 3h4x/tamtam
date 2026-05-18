import { NextRequest, NextResponse } from 'next/server';
import { getReadinessReport } from '@/lib/shared/readiness';

export async function GET(request?: NextRequest) {
  if (request?.nextUrl.searchParams.get('deep') === '1') {
    const report = await getReadinessReport();
    return NextResponse.json({ status: report.ok ? 'ok' : 'degraded', ...report }, { status: report.ok ? 200 : 503 });
  }
  return NextResponse.json({ status: 'ok' });
}
