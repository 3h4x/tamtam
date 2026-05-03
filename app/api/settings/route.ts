import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings, reloadConfig } from '@/lib/shared/config';
import { syncJobsPauseState } from '@/lib/shared/job-control';
import {
  encodeBudgetSubscriptionProviders,
  normalizeBudgetSubscriptionProviders,
} from '@/lib/usage/subscription-providers';
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
  'jobs_paused',
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
  'notification_on_budget_blocked',
  'budget_block_runs_enabled',
  'budget_subscription_providers',
  'budget_block_at_pct',
  'budget_warn_at_pct',
  'pipeline_model_review',
  'pipeline_model_fix',
  'pipeline_model_dod',
  'pipeline_model_commit',
] as const;

function serializeSettingValue(key: string, value: unknown): string {
  if (key === 'budget_subscription_providers') {
    return encodeBudgetSubscriptionProviders(normalizeBudgetSubscriptionProviders(String(value)));
  }
  return String(value);
}

export async function GET() {
  const rows = db.select().from(schema.settings).all();
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = serializeSettingValue(row.key, row.value);
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
      const serializedValue = serializeSettingValue(key, value);
      db.insert(schema.settings)
        .values({ key, value: serializedValue })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: serializedValue },
        })
        .run();
    }
  }

  reloadConfig();
  syncJobsPauseState(getSettings().jobs_paused);
  return NextResponse.json({ status: 'ok' });
}
