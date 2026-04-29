import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { reloadConfig } from '@/lib/config';
const SETTING_KEYS = [
  'github_owner',
  'claude_provider',
  'claude_bin',
  'lmstudio_model',
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
  'agent_templates',
  'log_retention_count',
  'log_retention_days',
  'job_row_retention_days',
  'notification_webhook_url',
  'notification_webhook_secret',
  'notification_on_release_success',
  'notification_on_release_fail',
  'notification_on_release_aborted',
  'notification_on_fix_loop_exhausted',
  'notification_on_review_do_not_ship',
  'notification_on_agent_run_fail',
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
    if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) continue;
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
