import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings, normalizePermissionMode, reloadConfig } from '@/lib/shared/config';
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
import {
  encodeEnabledProviders,
  isCliProvider,
  parseEnabledProviders,
} from '@/lib/usage/cli-providers';
import {
  canonicalizeTrustedGithubUsers,
  validateTrustedGithubUsersInput,
} from '@/lib/shared/trusted-github-users';

function firstEnabledProvider(value: string | null | undefined): string {
  const enabled = parseEnabledProviders(value);
  return enabled[0] ?? 'claude';
}

function parsePositiveIntegerSetting(
  value: unknown,
  label: string,
): { value: string | null; error: string | null } {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return { value: null, error: `${label} must be a positive integer.` };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { value: null, error: `${label} must be a positive integer.` };
  }
  return { value: String(parsed), error: null };
}

function parseNonNegativeIntegerSetting(
  value: unknown,
  label: string,
): { value: string | null; error: string | null } {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return { value: null, error: `${label} must be a non-negative integer.` };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, error: `${label} must be a non-negative integer.` };
  }
  return { value: String(parsed), error: null };
}

function parseBooleanSetting(
  value: unknown,
  label: string,
): { value: string | null; error: string | null } {
  if (typeof value === 'boolean') {
    return { value: value ? 'true' : 'false', error: null };
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === 'false') {
    return { value: raw, error: null };
  }
  return { value: null, error: `${label} must be true or false.` };
}

function parseUnitFloatSetting(
  value: unknown,
  label: string,
): { value: string | null; error: string | null } {
  const raw = String(value).trim();
  if (!raw) {
    return { value: null, error: `${label} must be a number between 0 and 1.` };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { value: null, error: `${label} must be a number between 0 and 1.` };
  }
  return { value: String(parsed), error: null };
}

async function buildSettingsResponse(): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.settings);
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.key as (typeof SETTING_KEYS)[number])) continue;
    settings[row.key] = serializeSettingValue(row.key, row.value);
  }

  const effective = getSettings();
  settings.claude_provider = serializeSettingValue('claude_provider', effective.claude_provider);
  settings.cli_enabled_providers = serializeSettingValue('cli_enabled_providers', effective.cli_enabled_providers);
  settings.review_fix_max_iterations = serializeSettingValue('review_fix_max_iterations', effective.review_fix_max_iterations);
  settings.release_wall_clock_timeout_minutes = serializeSettingValue('release_wall_clock_timeout_minutes', effective.release_wall_clock_timeout_minutes);
  if (effective.cli_bin_claude) {
    settings.cli_bin_claude = serializeSettingValue('cli_bin_claude', effective.cli_bin_claude);
  }

  return settings;
}
const SETTING_KEYS = [
  'github_owner',
  'trusted_github_users',
  'github_board_sync_enabled',
  'github_board_project_owner',
  'github_board_project_title',
  'github_board_project_number',
  'github_board_project_url',
  'github_board_view_url',
  'github_board_project_id',
  'github_board_status_field_id',
  'github_board_status_option_ids',
  'github_board_custom_field_ids',
  'claude_provider',
  'claude_bin',
  'lmstudio_model',
  'cli_enabled_providers',
  'cli_bin_claude',
  'cli_bin_codex',
  'cli_bin_gemini',
  'cli_bin_lmstudio',
  'cli_default_model_claude',
  'cli_default_model_codex',
  'cli_default_model_gemini',
  'cli_default_model_lmstudio',
  'log_dir',
  'frequency',
  'daytime',
  'weekends',
  'workspace_path',
  'base_prompt',
  'default_model',
  'permission_mode',
  'commit_style',
  'review_verdict_rules',
  'jobs_paused',
  'review_fix_max_iterations',
  'release_wall_clock_timeout_minutes',
  'agent_templates',
  'log_retention_count',
  'log_retention_days',
  'job_row_retention_days',
  'backup_retention_count',
  'backup_retention_weekly_count',
  'notification_webhook_url',
  'notification_webhook_secret',
  'notification_on_release_success',
  'notification_on_release_fail',
  'notification_on_release_aborted',
  'notification_on_fix_loop_exhausted',
  'notification_on_review_do_not_ship',
  'notification_on_agent_run_fail',
  'notification_on_budget_blocked',
  'notification_throttle_window_seconds',
  'notification_throttle_overrides',
  'budget_block_runs_enabled',
  'budget_subscription_providers',
  'budget_block_at_pct',
  'budget_warn_at_pct',
  'pipeline_model_review',
  'pipeline_model_fix',
  'pipeline_model_dod',
  'pipeline_model_commit',
  'dirty_worktree_block_threshold',
  'incremental_review_enabled',
  'retrieval_enabled',
  'retrieval_ollama_url',
  'retrieval_embedding_model',
  'retrieval_context_limit',
  'retrieval_score_threshold',
  'retrieval_manage_ollama',
] as const;

function serializeSettingValue(key: string, value: unknown): string {
  if (key === 'trusted_github_users') {
    if (Array.isArray(value)) return canonicalizeTrustedGithubUsers(value).join(', ');
    try { return canonicalizeTrustedGithubUsers(JSON.parse(String(value))).join(', '); } catch {}
    return canonicalizeTrustedGithubUsers(String(value)).join(', ');
  }
  if (key === 'github_board_status_option_ids' || key === 'github_board_custom_field_ids') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }
  if (key === 'budget_subscription_providers') {
    return encodeBudgetSubscriptionProviders(normalizeBudgetSubscriptionProviders(String(value)));
  }
  if (key === 'cli_enabled_providers') {
    if (Array.isArray(value)) {
      return encodeEnabledProviders(value.filter(isCliProvider));
    }
    return encodeEnabledProviders(parseEnabledProviders(String(value)));
  }
  if (
    key === 'cli_default_model_claude' ||
    key === 'cli_default_model_codex' ||
    key === 'cli_default_model_gemini' ||
    key === 'cli_default_model_lmstudio'
  ) {
    return normalizeModelInput(String(value), 'normal');
  }
  if (key === 'default_model') {
    return normalizeModelInput(String(value), 'fast');
  }
  if (key === 'permission_mode') {
    return normalizePermissionMode(String(value));
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
  if (key === 'trusted_github_users' && typeof value === 'string' && value.trim() === '') {
    return { value: null, error: null };
  }

  if (value === null || value === '') {
    return { value: null, error: null };
  }

  if (key === 'default_model') {
    const parsed = parseOptionalKnownModelInput(value, 'fast');
    if (parsed.error) return { value: null, error: parsed.error };
    return { value: parsed.model ?? 'fast', error: null };
  }

  if (key === 'permission_mode') {
    const raw = String(value).trim();
    if (!raw) return { value: null, error: null };
    if (normalizePermissionMode(raw) !== raw) {
      return { value: null, error: `permission_mode must be one of: acceptEdits, auto, bypassPermissions, default, dontAsk, plan.` };
    }
    return { value: raw, error: null };
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

  if (key === 'review_fix_max_iterations' || key === 'release_wall_clock_timeout_minutes') {
    return parsePositiveIntegerSetting(value, key);
  }

  if (key === 'retrieval_context_limit') {
    return parsePositiveIntegerSetting(value, key);
  }

  if (key === 'retrieval_score_threshold') {
    return parseUnitFloatSetting(value, key);
  }

  if (key === 'retrieval_enabled' || key === 'retrieval_manage_ollama') {
    return parseBooleanSetting(value, key);
  }

  if (key === 'notification_throttle_window_seconds') {
    return parsePositiveIntegerSetting(value, 'notification_throttle_window_seconds');
  }

  if (key === 'backup_retention_count' || key === 'backup_retention_weekly_count') {
    return parseNonNegativeIntegerSetting(value, key);
  }

  if (key === 'notification_throttle_overrides') {
    try {
      const parsed = JSON.parse(String(value));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: null, error: 'notification_throttle_overrides must be a JSON object.' };
      }
      const normalized: Record<string, number> = {};
      for (const [event, seconds] of Object.entries(parsed)) {
        const n = typeof seconds === 'number' ? seconds : Number.parseInt(String(seconds), 10);
        if (!Number.isFinite(n) || n < 0) {
          return { value: null, error: 'notification_throttle_overrides values must be non-negative seconds.' };
        }
        normalized[event] = n;
      }
      return { value: JSON.stringify(normalized), error: null };
    } catch {
      return { value: null, error: 'notification_throttle_overrides must be valid JSON.' };
    }
  }

  if (key === 'trusted_github_users') {
    const error = validateTrustedGithubUsersInput(value);
    if (error) return { value: null, error };
    const users = canonicalizeTrustedGithubUsers(value);
    return { value: JSON.stringify(users), error: null };
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
  return NextResponse.json({ settings: await buildSettingsResponse() });
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

  const cliEnabledEntry = serializedEntries.find((entry) => entry.key === 'cli_enabled_providers');
  const claudeProviderEntry = serializedEntries.find((entry) => entry.key === 'claude_provider');
  if (cliEnabledEntry) {
    const syncedProvider = firstEnabledProvider(cliEnabledEntry.value);
    if (claudeProviderEntry) {
      if (claudeProviderEntry.value === 'custom' && syncedProvider === 'claude') {
        // `cli_enabled_providers` cannot encode the legacy custom-provider
        // state, so a GET→PATCH round-trip for an unrelated save must not
        // silently downgrade it back to plain Claude routing.
      } else {
      claudeProviderEntry.value = syncedProvider;
      }
    } else {
      serializedEntries.push({
        key: 'claude_provider',
        value: syncedProvider,
      });
    }
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
        { key: 'github_board_project_url', value: ensured.projectUrl },
        { key: 'github_board_project_id', value: ensured.projectId },
        { key: 'github_board_status_field_id', value: ensured.statusFieldId },
        { key: 'github_board_status_option_ids', value: JSON.stringify(ensured.optionIds) },
        { key: 'github_board_custom_field_ids', value: JSON.stringify(ensured.customFieldIds) },
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
      await db.delete(schema.settings).where(eq(schema.settings.key, key));
    } else {
      await db.insert(schema.settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value },
        });
    }
  }

  reloadConfig();
  syncJobsPauseState(getSettings().jobs_paused);
  return NextResponse.json({ status: 'ok', settings: await buildSettingsResponse() });
}
