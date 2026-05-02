import { NextResponse } from 'next/server';
import { getClaudeQuota, clearQuotaCache } from '@/lib/usage/claude-quota';
import { getSettings } from '@/lib/shared/config';

function gateEnabled(): boolean {
  try { return getSettings()?.budget_block_runs_enabled === true; } catch { return false; }
}

export async function GET() {
  try {
    const snapshot = await getClaudeQuota();
    return NextResponse.json({ ...snapshot, gateEnabled: gateEnabled() });
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
    return NextResponse.json({ ...snapshot, gateEnabled: gateEnabled() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
