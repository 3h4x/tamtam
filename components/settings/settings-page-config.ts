import { DEFAULTS } from '@/components/settings/constants'

export interface SettingsMap {
  workspace_path: string
  github_owner: string
  auth_token_configured: string
  trusted_github_users: string
  github_board_sync_enabled: string
  github_board_project_owner: string
  github_board_project_title: string
  github_board_project_number: string
  github_board_project_url: string
  github_board_view_url: string
  claude_provider: string
  claude_bin: string
  cli_enabled_providers: string
  cli_bin_claude: string
  cli_bin_codex: string
  cli_bin_gemini: string
  cli_bin_lmstudio: string
  cli_bin_deepagents: string
  cli_deepagents_backend: string
  cli_deepagents_base_url: string
  cli_default_model_claude: string
  cli_default_model_codex: string
  cli_default_model_gemini: string
  cli_default_model_lmstudio: string
  cli_default_model_deepagents: string
  provider_fallback_chain: string
  lmstudio_model: string
  log_dir: string
  frequency: string
  daytime: string
  weekends: string
  base_prompt: string
  default_model: string
  permission_mode: string
  commit_style: string
  review_verdict_rules: string
  jobs_paused: string
  rebuild_in_progress: string
  prompt_estimate_warn_tokens: string
  prompt_estimate_block_tokens: string
  fix_max_iterations: string
  release_min_lines: string
  auto_pause_unfruitful_enabled: string
  auto_pause_unfruitful_runs: string
  auto_pause_unfruitful_rate: string
  release_reinforce_max_iterations: string
  review_fix_backoff_seconds: string
  review_do_not_ship_action: string
  release_wall_clock_timeout_minutes: string
  mark_dod_verify_timeout_ms: string
  run_token_cap: string
  run_wall_time_cap_minutes: string
  project_failure_threshold: string
  project_failure_window_minutes: string
  legacy_completion_hook_release_after_run_enabled: string
  legacy_completion_hook_release_after_fix_ci_enabled: string
  legacy_completion_hook_auto_resume_enabled: string
  legacy_pipeline_lock_inline_drain_enabled: string
  legacy_completion_hook_agent_drain_enabled: string
  plain_test_phase_enabled: string
  agent_templates: string
  log_retention_count: string
  log_retention_days: string
  job_row_retention_days: string
  workflow_run_retention_days: string
  skill_revision_retention_count: string
  backup_retention_count: string
  backup_retention_weekly_count: string
  db_backup_enabled: string
  db_backup_interval_minutes: string
  notification_webhook_url: string
  notification_webhook_secret: string
  notification_on_release_success: string
  notification_on_release_fail: string
  notification_on_release_aborted: string
  notification_on_fix_loop_exhausted: string
  notification_on_review_do_not_ship: string
  notification_on_agent_run_fail: string
  notification_on_budget_blocked: string
  notification_on_budget_exceeded: string
  notification_throttle_window_seconds: string
  notification_throttle_overrides: string
  budget_block_runs_enabled: string
  budget_block_on_weekly_pace_enabled: string
  budget_subscription_providers: string
  budget_block_at_pct: string
  budget_warn_at_pct: string
  pipeline_model_review: string
  pipeline_model_fix: string
  pipeline_model_dod: string
  pipeline_model_commit: string
  project_sweep_enabled: string
  dirty_worktree_block_threshold: string
  incremental_review_enabled: string
  retrieval_enabled: string
  retrieval_ollama_url: string
  retrieval_embedding_model: string
  retrieval_context_limit: string
  retrieval_score_threshold: string
  retrieval_manage_ollama: string
  retrieval_reindex_interval_hours: string
  browser_broker_enabled: string
  browser_broker_image: string
  browser_broker_mode: string
  tamtam_network_policy_strict: string
  orchestrator_enabled: string
  orchestrator_boost_margin_pct: string
  orchestrator_max_boosts_per_hour: string
  agent_autopilot_enabled: string
  initiative_engine_enabled: string
  initiative_mining_enabled: string
  initiative_dispatch_enabled: string
  initiative_max_ships_per_day: string
  initiative_max_backlog_per_project: string
  initiative_mining_interval_minutes: string
}

export const SETTINGS_DEFAULTS: SettingsMap = {
  ...DEFAULTS,
  github_board_sync_enabled: 'false',
  auth_token_configured: 'false',
  github_board_project_owner: '',
  github_board_project_title: 'TamTam',
  github_board_project_number: '',
  github_board_project_url: '',
  github_board_view_url: '',
  cli_enabled_providers: 'claude',
  cli_bin_claude: '',
  cli_bin_codex: '',
  cli_bin_gemini: '',
  cli_bin_lmstudio: '',
  cli_bin_deepagents: '',
  cli_deepagents_backend: 'lmstudio',
  cli_deepagents_base_url: '',
  cli_default_model_claude: 'normal',
  cli_default_model_codex: 'normal',
  cli_default_model_gemini: 'normal',
  cli_default_model_lmstudio: 'normal',
  cli_default_model_deepagents: 'normal',
  provider_fallback_chain: '',
  jobs_paused: 'false',
  rebuild_in_progress: 'false',
  notification_on_budget_blocked: 'false',
  notification_on_budget_exceeded: 'false',
  notification_throttle_window_seconds: '900',
  notification_throttle_overrides: '{"release_fail":0,"release_aborted":0}',
  db_backup_enabled: 'true',
  db_backup_interval_minutes: '15',
  budget_block_runs_enabled: 'false',
  budget_block_on_weekly_pace_enabled: 'true',
  budget_subscription_providers: 'claude,codex',
  budget_block_at_pct: '95',
  budget_warn_at_pct: '80',
  retrieval_enabled: 'true',
  retrieval_ollama_url: 'http://localhost:11434',
  retrieval_embedding_model: 'nomic-embed-text',
  retrieval_context_limit: '5',
  retrieval_score_threshold: '0.8',
  retrieval_manage_ollama: 'true',
  retrieval_reindex_interval_hours: '16',
  browser_broker_enabled: 'false',
  browser_broker_image: 'mcr.microsoft.com/playwright/mcp:v0.0.30',
  browser_broker_mode: 'docker',
  tamtam_network_policy_strict: 'false',
  orchestrator_enabled: 'false',
  orchestrator_boost_margin_pct: '5',
  orchestrator_max_boosts_per_hour: '2',
  agent_autopilot_enabled: 'true',
  auto_pause_unfruitful_enabled: 'true',
  auto_pause_unfruitful_runs: '6',
  auto_pause_unfruitful_rate: '0.2',
  initiative_engine_enabled: 'false',
  initiative_mining_enabled: 'true',
  initiative_dispatch_enabled: 'true',
  initiative_max_ships_per_day: '3',
  initiative_max_backlog_per_project: '50',
  initiative_mining_interval_minutes: '60',
}

export type TabId = 'general' | 'auth' | 'cli' | 'pipeline' | 'projects' | 'database' | 'templates' | 'notifications'

export type TabLayoutEntry =
  | { kind: 'subsection'; id: string }
  | { kind: 'inline'; id: 'trusted' | 'retrieval' | 'github_board' }

// Ordered list of cards rendered inside General / Pipeline tabs. Other tabs
// have their own dedicated components and bypass this layout.
export const TAB_LAYOUT: Partial<Record<TabId, TabLayoutEntry[]>> = {
  general: [
    { kind: 'subsection', id: 'workspace' },
    { kind: 'subsection', id: 'scheduling' },
    { kind: 'inline', id: 'trusted' },
    { kind: 'subsection', id: 'base_prompt' },
    { kind: 'subsection', id: 'browser_broker' },
    { kind: 'inline', id: 'retrieval' },
    { kind: 'inline', id: 'github_board' },
  ],
  pipeline: [
    { kind: 'subsection', id: 'review' },
    { kind: 'subsection', id: 'commit' },
    { kind: 'subsection', id: 'pipeline_models' },
    { kind: 'subsection', id: 'release_ops' },
    { kind: 'subsection', id: 'run_caps' },
    { kind: 'subsection', id: 'orchestrator' },
    { kind: 'subsection', id: 'initiatives' },
    { kind: 'subsection', id: 'retention' },
    { kind: 'subsection', id: 'legacy' },
  ],
}

export const TABS: { id: TabId; label: string }[] = [
  { id: 'general',       label: 'General' },
  { id: 'auth',          label: 'Auth' },
  { id: 'cli',           label: 'CLI' },
  { id: 'pipeline',      label: 'Pipeline' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'projects',      label: 'Projects' },
  { id: 'templates',     label: 'Templates' },
  { id: 'database',      label: 'Database' },
]

export interface ProjectEntry {
  name: string
  path: string
  enabled: boolean
  github: string | null
  priority: string | null
  archived: boolean
}

export function mergeLoadedSettings(settings: Partial<SettingsMap> | undefined): SettingsMap {
  return { ...SETTINGS_DEFAULTS, ...(settings ?? {}) }
}
