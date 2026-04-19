import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { reloadConfig } from '@/lib/config';
const SETTING_KEYS = [
  'github_owner',
  'claude_bin',
  'log_dir',
  'frequency',
  'daytime',
  'weekends',
  'launchagent_prefix',
  'workspace_path',
  'base_prompt',
  'default_model',
  'permission_mode',
  'commit_style',
  'review_verdict_rules',
  'fix_ci_max_retries',
  'fix_ci_retry_window_seconds',
  'fix_ci_fast_crash_ms',
] as const;

export async function GET() {
  const rows = db.select().from(schema.settings).all();
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return NextResponse.json({ settings });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();

  for (const [key, value] of Object.entries(body)) {
    if (!SETTING_KEYS.includes(key as any)) continue;
    if (value === null || value === '') {
      db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    } else {
      db.insert(schema.settings)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: String(value) },
        })
        .run();
    }
  }

  reloadConfig();
  return NextResponse.json({ status: 'ok' });
}
