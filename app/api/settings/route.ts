import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings, reloadConfig } from '@/lib/shared/config';
import { syncJobsPauseState } from '@/lib/shared/job-control';
import {
  encodeBudgetSubscriptionProviders,
  normalizeBudgetSubscriptionProviders,
} from '@/lib/usage/subscription-providers';
import {
  normalizeModelInput,
  parseOptionalKnownModelInput,
  resolveModelAlias,
} from '@/lib/agents/model-aliases';
const SETTING_KEYS = [
  'github_owner',
  'github_board_sync_enabled',
  'github_board_project_owner',
  'github_board_project_title',
  'github_board_project_number',
  'github_board_project_id',
  'github_board_status_field_id',
  'github_board_status_option_ids',
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
  if (key === 'github_board_status_option_ids') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }
  if (key === 'budget_subscription_providers') {
    return encodeBudgetSubscriptionProviders(normalizeBudgetSubscriptionProviders(String(value)));
  }
  if (key === 'default_model') {
    return normalizeModelInput(String(value), 'fast');
  }
  if (
    key === 'pipeline_model_review' ||
    key === 'pipeline_model_fix' ||
    key === 'pipeline_model_dod' ||
    key === 'pipeline_model_commit'
  ) {
    return resolveModelAlias(String(value));
  }
  if (key === 'agent_templates') {
    try {
      const templates = JSON.parse(String(value));
      if (Array.isArray(templates)) {
        return JSON.stringify(templates.map((template) => (
          template && typeof template === 'object'
            ? { ...template, model: normalizeModelInput(String(template.model ?? ''), 'normal') }
            : template
        )));
      }
    } catch {}
  }
  return String(value);
}

function validateAndSerializeSettingValue(
  key: (typeof SETTING_KEYS)[number],
  value: unknown
): { value: string | null; error: string | null } {
  if (value === null || value === '') {
    return { value: null, error: null };
  }

  if (key === 'default_model') {
    const parsed = parseOptionalKnownModelInput(value, 'fast');
    if (parsed.error) return { value: null, error: parsed.error };
    return { value: parsed.model ?? 'fast', error: null };
  }

  if (
    key === 'pipeline_model_review' ||
    key === 'pipeline_model_fix' ||
    key === 'pipeline_model_dod' ||
    key === 'pipeline_model_commit'
  ) {
    const parsed = parseOptionalKnownModelInput(value, 'fast');
    if (parsed.error) return { value: null, error: parsed.error };
    return { value: parsed.model, error: null };
  }

  if (key === 'agent_templates') {
    try {
      const templates = JSON.parse(String(value));
      if (!Array.isArray(templates)) {
        return { value: null, error: 'Invalid agent_templates payload.' };
      }
      const normalizedTemplates = templates.map((template) => {
        if (!template || typeof template !== 'object') return template;
        const parsed = parseOptionalKnownModelInput(
          'model' in template ? (template as Record<string, unknown>).model : undefined,
          'normal'
        );
        if (parsed.error) throw new Error(parsed.error);
        return {
          ...template,
          model: parsed.model ?? 'normal',
        };
      });
      return { value: JSON.stringify(normalizedTemplates), error: null };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error && error.message ? error.message : 'Invalid agent_templates payload.',
      };
    }
  }

  return { value: serializeSettingValue(key, value), error: null };
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
  const serializedEntries: Array<{ key: (typeof SETTING_KEYS)[number]; value: string | null }> = [];

  for (const [key, value] of Object.entries(body)) {
    if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) continue;
    const validated = validateAndSerializeSettingValue(key as (typeof SETTING_KEYS)[number], value);
    if (validated.error) {
      return NextResponse.json({ detail: validated.error }, { status: 400 });
    }
    serializedEntries.push({ key: key as (typeof SETTING_KEYS)[number], value: validated.value });
  }

  const desired = {
    ...getSettings(),
    ...Object.fromEntries(serializedEntries.map((entry) => [entry.key, entry.value])),
  } as Record<string, unknown>;
  if (desired.github_board_sync_enabled === 'true') {
    try {
      const { ensureProjectBoard } = await import('@/lib/github/project-board');
      const ensured = await ensureProjectBoard({
        enabled: true,
        owner: String(desired.github_board_project_owner || desired.github_owner || ''),
        title: String(desired.github_board_project_title || 'TamTam'),
      });
      const ensuredEntries: Array<{ key: (typeof SETTING_KEYS)[number]; value: string }> = [
        { key: 'github_board_project_owner', value: ensured.owner },
        { key: 'github_board_project_title', value: ensured.title },
        { key: 'github_board_project_number', value: ensured.projectNumber },
        { key: 'github_board_project_id', value: ensured.projectId },
        { key: 'github_board_status_field_id', value: ensured.statusFieldId },
        { key: 'github_board_status_option_ids', value: JSON.stringify(ensured.optionIds) },
      ];
      for (const entry of ensuredEntries) {
        const existing = serializedEntries.find((candidate) => candidate.key === entry.key);
        if (existing) existing.value = entry.value;
        else serializedEntries.push(entry);
      }
    } catch (error) {
      return NextResponse.json(
        { detail: error instanceof Error ? error.message : 'Failed to configure GitHub board sync.' },
        { status: 502 }
      );
    }
  }

  for (const { key, value } of serializedEntries) {
    if (value === null) {
      db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    } else {
      db.insert(schema.settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        })
        .run();
    }
  }

  reloadConfig();
  syncJobsPauseState(getSettings().jobs_paused);
  return NextResponse.json({ status: 'ok' });
}
