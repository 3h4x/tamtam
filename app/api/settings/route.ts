import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import {
  buildConfigFromSettingsMap,
  normalizeBrowserBrokerImage,
  normalizePermissionMode,
  reloadConfig,
  REVIEW_DO_NOT_SHIP_ACTIONS,
} from '@/lib/shared/config';
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
import { hashAuthToken } from '@/lib/auth/token';

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

function parsePositiveIntegerInRangeSetting(
  value: unknown,
  label: string,
  min: number,
  max: number,
): { value: string | null; error: string | null } {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return { value: null, error: `${label} must be a positive integer.` };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { value: null, error: `${label} must be a positive integer between ${min} and ${max}.` };
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

function parseReviewDoNotShipActionSetting(
  value: unknown,
): { value: string | null; error: string | null } {
  const raw = String(value).trim();
  if ((REVIEW_DO_NOT_SHIP_ACTIONS as readonly string[]).includes(raw)) {
    return { value: raw, error: null };
  }
  return {
    value: null,
    error: `review_do_not_ship_action must be one of: ${REVIEW_DO_NOT_SHIP_ACTIONS.join(', ')}.`,
  };
}

async function buildSettingsResponse(): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.settings);
  const rowMap = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.key as (typeof SETTING_KEYS)[number])) continue;
    if (row.key === 'auth_token') continue;
    settings[row.key] = serializeSettingValue(row.key, row.value);
  }
  settings.auth_token_configured = rowMap.auth_token ? 'true' : 'false';

  const effective = buildConfigFromSettingsMap(rowMap);
  settings.claude_provider = serializeSettingValue('claude_provider', effective.claude_provider);
  settings.cli_enabled_providers = serializeSettingValue('cli_enabled_providers', effective.cli_enabled_providers);
  settings.provider_fallback_chain = serializeSettingValue('provider_fallback_chain', effective.provider_fallback_chain);
  settings.prompt_estimate_warn_tokens = serializeSettingValue('prompt_estimate_warn_tokens', effective.prompt_estimate_warn_tokens);
  settings.prompt_estimate_block_tokens = serializeSettingValue('prompt_estimate_block_tokens', effective.prompt_estimate_block_tokens);
  settings.fix_max_iterations = serializeSettingValue('fix_max_iterations', effective.fix_max_iterations);
  settings.release_min_lines = serializeSettingValue('release_min_lines', effective.release_min_lines);
  settings.auto_pause_unfruitful_enabled = serializeSettingValue('auto_pause_unfruitful_enabled', effective.auto_pause_unfruitful_enabled);
  settings.auto_pause_unfruitful_runs = serializeSettingValue('auto_pause_unfruitful_runs', effective.auto_pause_unfruitful_runs);
  settings.auto_pause_unfruitful_rate = serializeSettingValue('auto_pause_unfruitful_rate', effective.auto_pause_unfruitful_rate);
  settings.release_reinforce_max_iterations = serializeSettingValue('release_reinforce_max_iterations', effective.release_reinforce_max_iterations);
  settings.review_do_not_ship_action = serializeSettingValue('review_do_not_ship_action', effective.review_do_not_ship_action);
  settings.release_wall_clock_timeout_minutes = serializeSettingValue('release_wall_clock_timeout_minutes', effective.release_wall_clock_timeout_minutes);
  settings.mark_dod_verify_timeout_ms = serializeSettingValue('mark_dod_verify_timeout_ms', effective.mark_dod_verify_timeout_ms);
  settings.plain_test_phase_enabled = serializeSettingValue('plain_test_phase_enabled', effective.plain_test_phase_enabled);
  settings.browser_broker_image = serializeSettingValue('browser_broker_image', effective.browser_broker_image);
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
  'cli_bin_deepagents',
  'cli_deepagents_backend',
  'cli_deepagents_base_url',
  'cli_default_model_claude',
  'cli_default_model_codex',
  'cli_default_model_gemini',
  'cli_default_model_lmstudio',
  'cli_default_model_deepagents',
  'provider_fallback_chain',
  'log_dir',
  'frequency',
  'daytime',
  'weekends',
  'workspace_path',
  'auth_token',
  'base_prompt',
  'default_model',
  'permission_mode',
  'commit_style',
  'review_verdict_rules',
  'jobs_paused',
  'rebuild_in_progress',
  'prompt_estimate_warn_tokens',
  'prompt_estimate_block_tokens',
  'fix_max_iterations',
  'release_min_lines',
  'auto_pause_unfruitful_enabled',
  'auto_pause_unfruitful_runs',
  'auto_pause_unfruitful_rate',
  'release_reinforce_max_iterations',
  'review_fix_backoff_seconds',
  'review_do_not_ship_action',
  'release_wall_clock_timeout_minutes',
  'mark_dod_verify_timeout_ms',
  'legacy_completion_hook_release_after_run_enabled',
  'legacy_completion_hook_release_after_fix_ci_enabled',
  'legacy_completion_hook_auto_resume_enabled',
  'legacy_pipeline_lock_inline_drain_enabled',
  'legacy_completion_hook_agent_drain_enabled',
  'plain_test_phase_enabled',
  'agent_templates',
  'log_retention_count',
  'log_retention_days',
  'job_row_retention_days',
  'workflow_run_retention_days',
  'skill_revision_retention_count',
  'backup_retention_count',
  'backup_retention_weekly_count',
  'db_backup_enabled',
  'db_backup_interval_minutes',
  'notification_webhook_url',
  'notification_webhook_secret',
  'notification_on_release_success',
  'notification_on_release_fail',
  'notification_on_release_aborted',
  'notification_on_fix_loop_exhausted',
  'notification_on_review_do_not_ship',
  'notification_on_agent_run_fail',
  'notification_on_budget_blocked',
  'notification_on_budget_exceeded',
  'notification_on_flaky_test_detected',
  'notification_throttle_window_seconds',
  'notification_throttle_overrides',
  'budget_block_runs_enabled',
  'budget_block_on_weekly_pace_enabled',
  'budget_subscription_providers',
  'budget_block_at_pct',
  'budget_warn_at_pct',
  'pipeline_model_review',
  'pipeline_model_fix',
  'pipeline_model_dod',
  'pipeline_model_commit',
  'project_sweep_enabled',
  'dirty_worktree_block_threshold',
  'incremental_review_enabled',
  'retrieval_enabled',
  'retrieval_ollama_url',
  'retrieval_embedding_model',
  'retrieval_context_limit',
  'retrieval_score_threshold',
  'retrieval_manage_ollama',
  'retrieval_reindex_interval_hours',
  'browser_broker_enabled',
  'browser_broker_image',
  'browser_broker_mode',
  'tamtam_network_policy_strict',
  'orchestrator_enabled',
  'orchestrator_boost_margin_pct',
  'orchestrator_max_boosts_per_hour',
  'agent_autopilot_enabled',
  'agent_autopilot_cadence_floor',
  'agent_autopilot_tier_floor',
  'agent_autopilot_idle_streak',
  'agent_autopilot_concern_streak',
  'initiative_engine_enabled',
  'initiative_mining_enabled',
  'initiative_dispatch_enabled',
  'initiative_max_ships_per_day',
  'initiative_max_backlog_per_project',
  'initiative_mining_interval_minutes',
] as const;

function serializeSettingValue(key: string, value: unknown): string {
  if (key === 'auth_token') return '';
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
  if (key === 'browser_broker_image') {
    return normalizeBrowserBrokerImage(String(value));
  }
  if (key === 'browser_broker_mode') {
    return String(value) === 'host' ? 'host' : 'docker';
  }
  if (key === 'cli_enabled_providers') {
    if (Array.isArray(value)) {
      return encodeEnabledProviders(value.filter(isCliProvider));
    }
    return encodeEnabledProviders(parseEnabledProviders(String(value)));
  }
  if (key === 'provider_fallback_chain') {
    if (Array.isArray(value)) {
      return encodeEnabledProviders(value.filter(isCliProvider));
    }
    return encodeEnabledProviders(parseEnabledProviders(String(value)));
  }
  if (
    key === 'cli_default_model_claude' ||
    key === 'cli_default_model_codex' ||
    key === 'cli_default_model_gemini' ||
    key === 'cli_default_model_lmstudio' ||
    key === 'cli_default_model_deepagents'
  ) {
    return normalizeModelInput(String(value), 'normal');
  }
  if (key === 'default_model') {
    return normalizeModelInput(String(value), 'fast');
  }
  if (key === 'permission_mode') {
    return normalizePermissionMode(String(value));
  }

  if (key === 'review_do_not_ship_action') {
    const parsed = parseReviewDoNotShipActionSetting(value);
    return parsed.value ?? 'pass';
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

  if (key === 'auth_token') {
    if (value === null || value === '') return { value: null, error: null };
    const token = String(value).trim();
    if (token.length < 32) {
      return { value: null, error: 'auth_token must be at least 32 characters.' };
    }
    return { value: hashAuthToken(token), error: null };
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

  if (key === 'fix_max_iterations') {
    // Default is unlimited (0), but any positive integer caps review
    // verification rounds until LGTM or the release wall clock aborts.
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'prompt_estimate_warn_tokens' || key === 'prompt_estimate_block_tokens') {
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'release_min_lines') {
    // 0 disables the gate; any positive integer is the minimum cumulative
    // working-tree LOC before an auto-release fires.
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'auto_pause_unfruitful_runs') {
    // 0 pauses immediately on the first caught-up no-diff scheduled run.
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'auto_pause_unfruitful_rate') {
    // Fruitful-rate floor (0–1) for the rate-based auto-pause; 0 disables it.
    return parseUnitFloatSetting(value, key);
  }
  if (key === 'release_reinforce_max_iterations') {
    // 0 = unlimited (no-progress exit terminates); otherwise the max
    // consecutive reinforce re-runs before releasing whatever exists.
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'review_fix_backoff_seconds') {
    // 0 disables the exponential backoff. Otherwise this is the base
    // delay; the dispatcher doubles it past the 3rd iteration.
    return parseNonNegativeIntegerSetting(value, key);
  }
  if (key === 'release_wall_clock_timeout_minutes') {
    return parsePositiveIntegerSetting(value, key);
  }
  if (key === 'mark_dod_verify_timeout_ms') {
    return parsePositiveIntegerSetting(value, key);
  }

  if (key === 'review_do_not_ship_action') {
    return parseReviewDoNotShipActionSetting(value);
  }

  if (key === 'cli_deepagents_backend') {
    const raw = String(value).trim();
    if (raw === 'lmstudio' || raw === 'ollama') return { value: raw, error: null };
    return { value: null, error: 'cli_deepagents_backend must be one of: lmstudio, ollama.' };
  }

  if (key === 'retrieval_context_limit') {
    return parsePositiveIntegerSetting(value, key);
  }

  if (key === 'retrieval_reindex_interval_hours') {
    return parsePositiveIntegerInRangeSetting(value, key, 1, 168);
  }

  if (key === 'retrieval_score_threshold') {
    return parseUnitFloatSetting(value, key);
  }

  if (
    key === 'retrieval_enabled' ||
    key === 'retrieval_manage_ollama' ||
    key === 'project_sweep_enabled' ||
    key === 'budget_block_runs_enabled' ||
    key === 'budget_block_on_weekly_pace_enabled' ||
    key === 'legacy_completion_hook_release_after_run_enabled' ||
    key === 'legacy_completion_hook_release_after_fix_ci_enabled' ||
    key === 'legacy_completion_hook_auto_resume_enabled' ||
    key === 'legacy_pipeline_lock_inline_drain_enabled' ||
    key === 'legacy_completion_hook_agent_drain_enabled' ||
    key === 'plain_test_phase_enabled' ||
    key === 'browser_broker_enabled' ||
    key === 'tamtam_network_policy_strict' ||
    key === 'orchestrator_enabled' ||
    key === 'initiative_engine_enabled' ||
    key === 'initiative_mining_enabled' ||
    key === 'initiative_dispatch_enabled'
  ) {
    return parseBooleanSetting(value, key);
  }
  if (
    key === 'orchestrator_boost_margin_pct' ||
    key === 'orchestrator_max_boosts_per_hour' ||
    key === 'initiative_max_ships_per_day' ||
    key === 'initiative_max_backlog_per_project' ||
    key === 'initiative_mining_interval_minutes'
  ) {
    return parseNonNegativeIntegerSetting(value, key);
  }

  if (key === 'notification_throttle_window_seconds') {
    return parsePositiveIntegerSetting(value, 'notification_throttle_window_seconds');
  }

  if (
    key === 'workflow_run_retention_days' ||
    key === 'skill_revision_retention_count' ||
    key === 'backup_retention_count' ||
    key === 'backup_retention_weekly_count'
  ) {
    return parseNonNegativeIntegerSetting(value, key);
  }

  if (key === 'db_backup_interval_minutes') {
    return parsePositiveIntegerSetting(value, key);
  }
  if (key === 'db_backup_enabled') {
    return parseBooleanSetting(value, key);
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

  const currentRows = await db.select().from(schema.settings);
  const currentMap = Object.fromEntries(currentRows.map((row) => [row.key, row.value]));
  const desired = {
    ...buildConfigFromSettingsMap(currentMap),
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

  const finalDesired: Record<string, string> = { ...currentMap };
  for (const entry of serializedEntries) {
    if (entry.value === null) {
      delete finalDesired[entry.key];
    } else {
      finalDesired[entry.key] = entry.value;
    }
  }
  const effectiveAfterSave = buildConfigFromSettingsMap(finalDesired);

  // Snapshot the previous embedding-model BEFORE the upserts so we can
  // detect a change and kick the per-project documentation-reindex-vectors system
  // agent. The agent itself handles the wipe (it detects the mismatch via
  // retrieval_records.embedding_model), but we want the rebuild to start
  // immediately rather than waiting up to one schedule interval.
  const previousEmbeddingModel = currentMap['retrieval_embedding_model'];
  // Snapshot the previous reindex interval so we can detect a change after
  // the upsert and push the new schedule onto every system-agent row.
  const previousReindexHours = currentMap['retrieval_reindex_interval_hours'];

  // Per-setting upsert/delete is independent across keys — was N sequential
  // round-trips, now fans out via Promise.all.
  await Promise.all(serializedEntries.map(({ key, value }) => {
    if (value === null) {
      return db.delete(schema.settings).where(eq(schema.settings.key, key));
    }
    return db.insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value },
      });
  }));

  reloadConfig();
  syncJobsPauseState(effectiveAfterSave.jobs_paused);

  // Embedding-model change → immediate documentation-reindex-vectors kick.
  const newEmbeddingModel = finalDesired['retrieval_embedding_model'];
  if (
    previousEmbeddingModel &&
    newEmbeddingModel &&
    previousEmbeddingModel !== newEmbeddingModel
  ) {
    void (async () => {
      try {
        const connectionString = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL;
        if (!connectionString) return;
        const [{ quickAddJob }, { DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME }] = await Promise.all([
          import('graphile-worker'),
          import('@/lib/agents/system/constants'),
        ]);
        const rows = await db
          .select({ id: schema.agents.id, name: schema.agents.name, project: schema.agents.project })
          .from(schema.agents)
          .where(eq(schema.agents.kind, 'system'));
        const targets = rows.filter((r) => r.name === DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME);
        await Promise.all(
          targets.map((agent) =>
            quickAddJob(
              { connectionString },
              'agent-cron',
              { agentId: agent.id },
              { jobKey: `agent-cron-${agent.id}`, jobKeyMode: 'replace', runAt: new Date(), maxAttempts: 5 },
            )
          )
        );
        console.warn(
          `[settings] retrieval_embedding_model changed (${previousEmbeddingModel} → ${newEmbeddingModel}) — ` +
            `kicked ${targets.length} documentation-reindex-vectors agent(s)`,
        );
      } catch (err) {
        console.error('[settings] failed to kick documentation-reindex-vectors after model change:', err);
      }
    })();
  }

  // Reindex-interval change → push the new schedule onto every
  // documentation-reindex-vectors system agent row and reinstall its cron.
  // System agents are managed exclusively from /settings, so this is the
  // single sync point for their schedule.
  const newReindexHours = finalDesired['retrieval_reindex_interval_hours'];
  if (
    newReindexHours !== undefined &&
    String(previousReindexHours ?? '') !== String(newReindexHours)
  ) {
    void (async () => {
      try {
        const [
          { DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME },
          { installAgentSchedule, uninstallAgentSchedule },
        ] = await Promise.all([
          import('@/lib/agents/system/constants'),
          import('@/lib/scheduling/agent-scheduler'),
        ]);
        const newSchedule = `${effectiveAfterSave.retrieval_reindex_interval_hours}h`;
        const rows = await db
          .select({
            id: schema.agents.id,
            name: schema.agents.name,
            project: schema.agents.project,
            prompt: schema.agents.prompt,
            enabled: schema.agents.enabled,
          })
          .from(schema.agents)
          .where(eq(schema.agents.kind, 'system'));
        const targets = rows.filter((r) => r.name === DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME);
        if (targets.length === 0) return;
        await Promise.all(
          targets.map((agent) =>
            db.update(schema.agents)
              .set({ schedule: newSchedule, updatedAt: Date.now() / 1000 })
              .where(eq(schema.agents.id, agent.id))
              .execute()
          )
        );
        await Promise.all(
          targets.map((agent) => {
            if (agent.enabled) {
              return installAgentSchedule(agent.id, newSchedule, agent.prompt ?? '', agent.project, agent.name);
            }
            return uninstallAgentSchedule(agent.id, agent.project, agent.name);
          })
        );
        console.warn(
          `[settings] retrieval_reindex_interval_hours changed (${previousReindexHours ?? '(default)'} → ${newReindexHours}) — ` +
            `updated ${targets.length} documentation-reindex-vectors schedule(s) to ${newSchedule}`,
        );
      } catch (err) {
        console.error('[settings] failed to propagate retrieval_reindex_interval_hours change:', err);
      }
    })();
  }

  return NextResponse.json({ status: 'ok', settings: await buildSettingsResponse() });
}
