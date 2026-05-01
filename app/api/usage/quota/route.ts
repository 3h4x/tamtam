import { NextResponse } from 'next/server';
import { getClaudeQuota, clearQuotaCache } from '@/lib/usage/claude-quota';

export async function GET() {
  try {
    const snapshot = await getClaudeQuota();
    return NextResponse.json(snapshot);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}

export async function POST() {
  clearQuotaCache();
  try {
    const snapshot = await getClaudeQuota({ force: true });
    return NextResponse.json(snapshot);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
