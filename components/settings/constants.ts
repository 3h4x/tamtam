export type SettingsFieldKey =
  | 'workspace_path'
  | 'github_owner'
  | 'trusted_github_users'
  | 'claude_provider'
  | 'claude_bin'
  | 'lmstudio_model'
  | 'log_dir'
  | 'frequency'
  | 'daytime'
  | 'weekends'
  | 'base_prompt'
  | 'default_model'
  | 'permission_mode'
  | 'prompt_estimate_warn_tokens'
  | 'prompt_estimate_block_tokens'
  | 'commit_style'
  | 'review_verdict_rules'
  | 'fix_max_iterations'
  | 'release_min_lines'
  | 'auto_pause_unfruitful_enabled'
  | 'auto_pause_unfruitful_runs'
  | 'release_reinforce_max_iterations'
  | 'review_fix_backoff_seconds'
  | 'review_do_not_ship_action'
  | 'release_wall_clock_timeout_minutes'
  | 'mark_dod_verify_timeout_ms'
  | 'legacy_completion_hook_release_after_run_enabled'
  | 'legacy_completion_hook_release_after_fix_ci_enabled'
  | 'legacy_completion_hook_auto_resume_enabled'
  | 'legacy_pipeline_lock_inline_drain_enabled'
  | 'legacy_completion_hook_agent_drain_enabled'
  | 'plain_test_phase_enabled'
  | 'agent_templates'
  | 'log_retention_count'
  | 'log_retention_days'
  | 'job_row_retention_days'
  | 'workflow_run_retention_days'
  | 'skill_revision_retention_count'
  | 'backup_retention_count'
  | 'backup_retention_weekly_count'
  | 'notification_webhook_url'
  | 'notification_webhook_secret'
  | 'notification_on_release_success'
  | 'notification_on_release_fail'
  | 'notification_on_release_aborted'
  | 'notification_on_fix_loop_exhausted'
  | 'notification_on_review_do_not_ship'
  | 'notification_on_agent_run_fail'
  | 'notification_on_budget_blocked'
  | 'notification_on_budget_exceeded'
  | 'notification_throttle_window_seconds'
  | 'notification_throttle_overrides'
  | 'pipeline_model_review'
  | 'pipeline_model_fix'
  | 'pipeline_model_dod'
  | 'pipeline_model_commit'
  | 'project_sweep_enabled'
  | 'dirty_worktree_block_threshold'
  | 'incremental_review_enabled'
  | 'browser_broker_enabled'
  | 'browser_broker_image'
  | 'browser_broker_mode'
  | 'tamtam_network_policy_strict'
  | 'orchestrator_enabled'
  | 'orchestrator_boost_margin_pct'
  | 'orchestrator_max_boosts_per_hour'
  | 'agent_autopilot_enabled'
  | 'initiative_engine_enabled'
  | 'initiative_mining_enabled'
  | 'initiative_dispatch_enabled'
  | 'initiative_max_ships_per_day'
  | 'initiative_max_backlog_per_project'
  | 'initiative_mining_interval_minutes'

// `subsection` groups fields into named cards within their tab. The
// SUBSECTIONS registry below maps each id → display metadata (title, grid
// columns, default-collapsed). Fields without a subsection are rendered
// in a fallback flat grid for backwards compat.
export interface FieldDef {
  label: string
  help: string
  group: 'agent' | 'pipeline' | 'general'
  subsection?: string
  advanced?: boolean
  collapsible?: boolean
  span?: number
}

export interface SubsectionDef {
  title: string
  description?: string
  cols?: number
  /** Wrap the whole subsection in <details>, collapsed by default. */
  defaultCollapsed?: boolean
  /** Only render when "Advanced" toggle is on at the tab level. */
  advanced?: boolean
}

export const SUBSECTIONS: Record<string, SubsectionDef> = {
  // General tab
  workspace: {
    title: 'Workspace',
    description: 'Where TamTam scans for git projects and writes logs',
    cols: 3,
  },
  scheduling: {
    title: 'Scheduling',
    description: 'When scheduled agents are allowed to run',
    cols: 3,
  },
  base_prompt: {
    title: 'Base Prompt',
    description: 'Prepended to every TamTam-spawned run, agent, and review',
    cols: 1,
    defaultCollapsed: true,
  },
  browser_broker: {
    title: 'Browser Broker (Sandboxed Playwright)',
    description: 'Docker-hosted Playwright MCP that sandboxed agents can drive via mcp__tamtam_browser__*. See docs/BROWSER-BROKER.md.',
    cols: 2,
  },

  // Pipeline tab
  review: {
    title: 'Review & Verdict',
    description: 'Verdict rules and the review→fix loop',
    cols: 2,
  },
  commit: {
    title: 'Commit',
    description: 'Commit message style and dirty-worktree gating',
    cols: 2,
  },
  pipeline_models: {
    title: 'Per-Phase Model Tiers',
    description: 'Override the default tier per pipeline phase',
    cols: 2,
  },
  release_ops: {
    title: 'Release Limits',
    description: 'Timeouts and background workers around release runs',
    cols: 2,
  },
  retention: {
    title: 'Retention',
    description: 'How long log files and run history are kept',
    cols: 2,
    defaultCollapsed: true,
  },
  legacy: {
    title: 'Legacy Migration Switches',
    description: 'Runtime kill switches for the workflow-event migration. Disable while routing the matching events through the durable path. Leave on unless you know what you are doing.',
    cols: 2,
    defaultCollapsed: true,
  },
  orchestrator: {
    title: 'Orchestrator (Budget Allocator)',
    description: 'When pace is under, push bonus agent fires at shipping projects every 5 min so spare token budget converts into shipped work instead of going unused. Off by default — opt-in.',
    cols: 3,
  },
  initiatives: {
    title: 'Initiative Engine (Autonomous Backlog)',
    description: 'Mines each project for grounded work (lint, TODO/FIXME, API routes shipped without UI) and — unless mine-only — drives the top item through the release pipeline. Off by default. Mine-only = discover + fill backlog without auto-merge.',
    cols: 3,
  },
}

export const FIELDS: Record<SettingsFieldKey, FieldDef> = {
  workspace_path: {
    label: 'Workspace Path',
    help: 'Root directory containing your git projects',
    group: 'general',
    subsection: 'workspace',
    span: 2,
  },
  github_owner: {
    label: 'GitHub Owner',
    help: 'Default GitHub org/user for repos without an explicit remote',
    group: 'general',
    subsection: 'workspace',
    span: 1,
  },
  log_dir: {
    label: 'Log Directory',
    help: 'Directory where job logs are stored',
    group: 'general',
    subsection: 'workspace',
    advanced: true,
    span: 1,
  },
  trusted_github_users: {
    label: 'Trusted GitHub Users',
    help: 'Global allowlist for issue/PR authors whose GitHub content TamTam may treat as trusted. Managed through the dedicated editor in Settings → General.',
    group: 'general',
    span: 2,
  },
  frequency: {
    label: 'Base Frequency',
    help: 'How often scheduled agents run, e.g. "1h", "30m"',
    group: 'general',
    subsection: 'scheduling',
    span: 1,
  },
  daytime: {
    label: 'Allowed Hours',
    help: 'Time window when agents are permitted to run',
    group: 'general',
    subsection: 'scheduling',
    span: 1,
  },
  weekends: {
    label: 'Weekend Runs',
    help: 'Whether agents run on Saturdays and Sundays',
    group: 'general',
    subsection: 'scheduling',
    span: 1,
  },
  base_prompt: {
    label: 'Base Prompt',
    help: 'Prepended to every Claude invocation — runs, agents, and reviews',
    group: 'general',
    subsection: 'base_prompt',
    span: 1,
    collapsible: true,
  },
  browser_broker_enabled: {
    label: 'Browser Broker',
    help: 'Spin up a shared @playwright/mcp container so sandboxed agents can drive Chromium without escaping their sandbox.',
    group: 'general',
    subsection: 'browser_broker',
    span: 1,
  },
  tamtam_network_policy_strict: {
    label: 'Strict Network Policy (macOS)',
    help: 'Wrap each agent CLI in sandbox-exec with a loopback-only seatbelt profile. Currently macOS only; blocks the LLM API call unless paired with hostname allowlisting (v2). Default off.',
    group: 'general',
    subsection: 'browser_broker',
    span: 1,
  },
  orchestrator_enabled: {
    label: 'Orchestrator',
    help: 'Master switch. When on, the orchestrator-tick graphile cron fires every 5 min, looks at stats/bridge, and enqueues bonus agent runs on shipping projects whenever pace is under by at least the margin below. Skips paused, releasing, or stuck projects automatically.',
    group: 'pipeline',
    subsection: 'orchestrator',
    span: 1,
  },
  orchestrator_boost_margin_pct: {
    label: 'Boost margin (pp)',
    help: 'Only push bonus fires when the binding provider has at least this many percentage points of headroom vs. the on-pace line. Smaller = more aggressive; larger = more conservative.',
    group: 'pipeline',
    subsection: 'orchestrator',
    span: 1,
  },
  orchestrator_max_boosts_per_hour: {
    label: 'Max boosts / project / hour',
    help: 'Rolling-hour cap on bonus fires for any single project. Default 2 is two extra runs per hour over the existing schedule.',
    group: 'pipeline',
    subsection: 'orchestrator',
    span: 1,
  },
  agent_autopilot_enabled: {
    label: 'Agent autopilot',
    help: 'When on (default), the orchestrator reclaims wasted budget by role: it cadence-throttles churning producers (sustained loop/noise) and downgrades the model tier of idle monitors/reviewers/planners. All actions are floor-bounded and reversible; monitors are never cadence-throttled. Also requires Orchestrator on. Tuning params are API-only.',
    group: 'pipeline',
    subsection: 'orchestrator',
    span: 1,
  },
  initiative_engine_enabled: {
    label: 'Initiative engine',
    help: 'Master switch. Off by default — opt-in per deployment. When on, TamTam scans each project for grounded chore items (lint findings, TODO/FIXME comments, unmatched API routes) and — unless mine-only mode is active — drives the top backlog item through the release pipeline automatically.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  initiative_mining_enabled: {
    label: 'Mining',
    help: 'When on (default), the engine actively mines each project for grounded work items and fills the backlog. Turn off to pause discovery while leaving dispatch intact.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  initiative_dispatch_enabled: {
    label: 'Dispatch (auto-merge)',
    help: 'When off, the engine runs in mine-only mode: it discovers work and fills the backlog but never dispatches a release or merges anything. Useful to audit what the engine finds before enabling full autonomy.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  initiative_max_ships_per_day: {
    label: 'Max ships / project / day',
    help: 'Per-project cap on autonomous merges per calendar day. Prevents a runaway initiative from flooding the default branch. Default 3.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  initiative_max_backlog_per_project: {
    label: 'Max backlog / project',
    help: 'Admission cap on queued backlog items per project. Mining stops adding new items once this limit is reached. Default 50.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  initiative_mining_interval_minutes: {
    label: 'Mining interval (min)',
    help: 'Minimum minutes between mining runs for the same project. Prevents hammering a project on every tick. Default 60.',
    group: 'pipeline',
    subsection: 'initiatives',
    span: 1,
  },
  browser_broker_image: {
    label: 'Broker Image',
    help: 'Docker image tag for the broker container. Defaults to the pinned Microsoft Playwright MCP image.',
    group: 'general',
    subsection: 'browser_broker',
    span: 2,
    advanced: true,
  },
  browser_broker_mode: {
    label: 'Broker Mode',
    help: 'docker (default) runs Playwright MCP in a sandboxed container. host spawns it directly on the host — avoids Docker memory pressure but forgoes the container sandbox.',
    group: 'general',
    subsection: 'browser_broker',
    span: 1,
    advanced: true,
  },

  // Agent-group fields are rendered by CliTab — not by GROUPS auto-render.
  claude_provider: {
    label: 'Agent CLI Provider',
    help: 'Choose the Claude-compatible backend TamTam invokes for runs',
    group: 'agent',
    span: 1,
  },
  claude_bin: {
    label: 'Claude CLI Path',
    help: 'Used for Claude or Custom provider. Gemini, LM Studio, and Codex resolve to TamTam shim scripts.',
    group: 'agent',
    span: 1,
  },
  lmstudio_model: {
    label: 'Default Model',
    help: 'Downloaded LM Studio model identifier used as the default model for runs',
    group: 'agent',
    span: 1,
  },
  default_model: {
    label: 'Default Model Tier',
    help: 'Capability tier pre-selected in the terminal runner',
    group: 'agent',
    span: 1,
  },
  permission_mode: {
    label: 'Permission Mode',
    help: 'Permission flag passed to TamTam-spawned headless runs. auto (recommended) preserves provider-native non-interactive behavior across the bundled Claude, Gemini, and Codex shims. acceptEdits auto-accepts file edits. bypassPermissions skips all approval checks. plan is read-only.',
    group: 'agent',
    span: 1,
  },
  prompt_estimate_warn_tokens: {
    label: 'Prompt Estimate Warn Tokens',
    help: 'Estimated input-token threshold where run starts are marked as oversized. 0 disables warnings.',
    group: 'agent',
    span: 1,
  },
  prompt_estimate_block_tokens: {
    label: 'Prompt Estimate Block Tokens',
    help: 'Estimated input-token threshold where TamTam rejects a run before creating a job or spawning a provider process. 0 disables blocking.',
    group: 'agent',
    span: 1,
  },

  // Pipeline: review
  review_verdict_rules: {
    label: 'Review Verdict Rules',
    help: 'Rules that drive LGTM / NEEDS ATTENTION / DO NOT SHIP decisions in code reviews',
    group: 'pipeline',
    subsection: 'review',
    span: 2,
    collapsible: true,
  },
  fix_max_iterations: {
    label: 'Fix Loop Iterations',
    help: 'Single global cap on per-release fix→step→fix retries — applied uniformly to review, test, commit, and review-driven push loops. ∞ (default) lets each loop run until success (LGTM / green test / clean commit / successful push) or the release wall-clock timeout aborts. With a finite cap, exhaustion is NOT symmetric across step kinds: review exhaustion on a NEEDS ATTENTION verdict files a follow-up issue with unresolved findings and ships the partial work (review with a DO NOT SHIP verdict still aborts); test, commit, and push exhaustion abort the release immediately without filing an issue. The push pre-push-hook rejection retry is a separate hardcoded cap (2) so a permanently failing hook can\'t loop forever when this is 0.',
    group: 'pipeline',
    subsection: 'review',
    span: 1,
  },
  review_do_not_ship_action: {
    label: 'Do Not Ship Action',
    help: 'Policy for DO NOT SHIP review verdicts. fix (default) routes back through the review fix loop; pass files a follow-up issue and continues to commit; abort stops the release.',
    group: 'pipeline',
    subsection: 'review',
    span: 1,
  },
  incremental_review_enabled: {
    label: 'Incremental Review',
    help: 'After an LGTM verdict, narrow the next review diff to commits since the last LGTM (uses a refs/tamtam/reviewed/<branch> ref).',
    group: 'pipeline',
    subsection: 'review',
    span: 1,
  },
  review_fix_backoff_seconds: {
    label: 'Review Fix Loop Backoff (seconds)',
    help: 'Base delay before each review→fix iteration past the third. Doubles each round (30→60→120→240→capped at 300). 0 disables. Useful with unlimited iterations so a slow-converging loop doesn\'t burn tokens/CI at full speed.',
    group: 'pipeline',
    subsection: 'review',
    advanced: true,
    span: 1,
  },

  // Pipeline: commit
  commit_style: {
    label: 'Commit Message Style',
    help: 'Style guide injected into the prompt when generating commit titles in the Push panel',
    group: 'pipeline',
    subsection: 'commit',
    span: 2,
    collapsible: true,
  },
  dirty_worktree_block_threshold: {
    label: 'Dirty Worktree Block Threshold',
    help: 'Block agent runs when the project has at least this many uncommitted files (incl. untracked). Default 1 blocks on any dirty worktree; set higher to allow small WIP, 0 to disable.',
    group: 'pipeline',
    subsection: 'commit',
    span: 1,
  },

  // Pipeline: per-phase model tiers
  pipeline_model_review: {
    label: 'Review Tier',
    help: 'Capability tier used for code review. "Default" uses the workspace Default Model Tier.',
    group: 'pipeline',
    subsection: 'pipeline_models',
    span: 1,
  },
  pipeline_model_fix: {
    label: 'Fix Tier',
    help: 'Capability tier used for the fix step. "Default" uses Smart because fixes edit code.',
    group: 'pipeline',
    subsection: 'pipeline_models',
    span: 1,
  },
  pipeline_model_dod: {
    label: 'DoD Tier',
    help: 'Capability tier used for DoD verification. Empty defaults to Fast — verification is read-only and cheap.',
    group: 'pipeline',
    subsection: 'pipeline_models',
    span: 1,
  },
  pipeline_model_commit: {
    label: 'Commit Message Tier',
    help: 'Capability tier used to generate commit messages. Empty defaults to Fast — short well-scoped task.',
    group: 'pipeline',
    subsection: 'pipeline_models',
    span: 1,
  },

  // Pipeline: release limits / boot toggles
  release_wall_clock_timeout_minutes: {
    label: 'Release Timeout (minutes)',
    help: 'Overall wall-clock budget for a Release run before the recovery sweep aborts it as timed out. Default 60.',
    group: 'pipeline',
    subsection: 'release_ops',
    span: 1,
  },
  mark_dod_verify_timeout_ms: {
    label: 'Mark-DoD Verify Timeout (ms)',
    help: 'Wall-clock cap for the mark-dod acceptance-criteria verification job (mark-dod-verify), enforced by the shared job-timeout reaper so it survives a restart. A verify past this cap is killed; mark-dod stays non-gating and the unchecked criteria are re-verified on a later run. Default 600000 (10 min).',
    group: 'pipeline',
    subsection: 'release_ops',
    advanced: true,
    span: 1,
  },
  release_min_lines: {
    label: 'Release Min Lines Changed',
    help: 'Minimum cumulative working-tree lines changed (added + removed) before an auto-triggered release fires. 0 (default) disables the gate. When set, a sub-threshold agent run is reinforced — the same agent is re-dispatched to do more — instead of running the pipeline on a trivial diff. Only applies to the auto-release path (Release After Run) for working-tree-dirty agent runs.',
    group: 'pipeline',
    subsection: 'release_ops',
    span: 1,
  },
  auto_pause_unfruitful_enabled: {
    label: 'Auto-pause Unfruitful Projects',
    help: 'When on, scheduled agent runs that repeatedly produce no diff and report nothing to do can pause the project automatically until it is resumed from Settings.',
    group: 'pipeline',
    subsection: 'release_ops',
    span: 1,
  },
  auto_pause_unfruitful_runs: {
    label: 'Auto-pause Runs',
    help: 'Consecutive caught-up no-diff scheduled runs required before auto-pausing a project.',
    group: 'pipeline',
    subsection: 'release_ops',
    advanced: true,
    span: 1,
  },
  release_reinforce_max_iterations: {
    label: 'Reinforce Max Iterations',
    help: 'Max consecutive reinforce re-runs per project before releasing whatever exists. 0 = unlimited (stops only when a re-run adds no new lines). Only used when Release Min Lines Changed is set.',
    group: 'pipeline',
    subsection: 'release_ops',
    advanced: true,
    span: 1,
  },
  project_sweep_enabled: {
    label: 'Project Sweep',
    help: 'Run the background project sweep worker when TamTam starts.',
    group: 'pipeline',
    subsection: 'release_ops',
    span: 1,
  },
  plain_test_phase_enabled: {
    label: 'Plain Test Phase',
    help: 'Run the release test phase as the detected shell test command instead of launching a Claude-driven test agent. Keep disabled while the deterministic path bakes.',
    group: 'pipeline',
    subsection: 'release_ops',
    span: 1,
  },

  // Pipeline: retention
  log_retention_count: {
    label: 'Log Retention (runs)',
    help: 'Keep log files for the last N finished runs per project. Older log files are deleted; the run row stays in history.',
    group: 'pipeline',
    subsection: 'retention',
    span: 1,
  },
  log_retention_days: {
    label: 'Log Retention (days)',
    help: 'Delete log files for runs older than this many days. Set to 0 to disable age-based pruning.',
    group: 'pipeline',
    subsection: 'retention',
    span: 1,
  },
  job_row_retention_days: {
    label: 'Run History Retention (days)',
    help: 'Nightly cleanup: delete run DB rows older than this many days. Set to 0 to disable.',
    group: 'pipeline',
    subsection: 'retention',
    span: 1,
  },
  workflow_run_retention_days: {
    label: 'Workflow Trace Retention (days)',
    help: 'Nightly cleanup: delete completed workflow runtime traces older than this many days. Set to 0 to disable.',
    group: 'pipeline',
    subsection: 'retention',
    span: 1,
  },
  skill_revision_retention_count: {
    label: 'Revision Retention (per item)',
    help: 'Nightly cleanup: keep this many newest skill and agent edit revisions per skill or agent. Set to 0 to disable.',
    group: 'pipeline',
    subsection: 'retention',
    span: 1,
  },

  // Pipeline: legacy migration switches
  legacy_completion_hook_release_after_run_enabled: {
    label: 'Legacy Release-After-Run Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts release-after-run. Disable while routing release triggers through the workflow event path.',
    group: 'pipeline',
    subsection: 'legacy',
    span: 1,
  },
  legacy_completion_hook_release_after_fix_ci_enabled: {
    label: 'Legacy Release-After-Fix-CI Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts release-after-fix-CI. Disable while routing fix-CI triggers through the workflow event path.',
    group: 'pipeline',
    subsection: 'legacy',
    span: 1,
  },
  legacy_completion_hook_auto_resume_enabled: {
    label: 'Legacy Auto-Resume Hook',
    help: 'Runtime kill switch for the legacy completion hook that starts auto-resume. Disable while routing auto-resume triggers through the workflow event path.',
    group: 'pipeline',
    subsection: 'legacy',
    span: 1,
  },
  legacy_pipeline_lock_inline_drain_enabled: {
    label: 'Legacy Pipeline Lock Drain',
    help: 'Runtime kill switch for inline pending-release and queued-agent draining after a pipeline lock is released. Disable while routing lock-release drains through the durable event path.',
    group: 'pipeline',
    subsection: 'legacy',
    span: 1,
  },
  legacy_completion_hook_agent_drain_enabled: {
    label: 'Legacy Agent Queue Drain Hook',
    help: 'Runtime kill switch for the legacy completion hook that drains queued agent runs. Disable while routing agent queue drains through the workflow event path.',
    group: 'pipeline',
    subsection: 'legacy',
    span: 1,
  },

  // Other group: 'pipeline' kept for back-compat — fields rendered by their own tabs/components.
  backup_retention_count: {
    label: 'Backup Retention (files)',
    help: 'Keep this many newest Postgres backup files after each successful backup. Set to 0 to prune all older backups after each run while still keeping the newly created backup.',
    group: 'pipeline',
    span: 1,
  },
  backup_retention_weekly_count: {
    label: 'Weekly Backup Retention',
    help: 'Also keep one older backup per week for this many weeks after the newest backups. Set to 0 to disable weekly retention.',
    group: 'pipeline',
    span: 1,
  },

  agent_templates: {
    label: 'Agent Templates',
    help: 'JSON array of custom agent templates (managed via the Templates tab)',
    group: 'templates' as never,
    span: 2,
  },
  notification_webhook_url: {
    label: 'Notification Webhook URL',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_webhook_secret: {
    label: 'Notification Webhook Secret',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_success: {
    label: 'Notification on Release Success',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_fail: {
    label: 'Notification on Release Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_release_aborted: {
    label: 'Notification on Release Aborted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_fix_loop_exhausted: {
    label: 'Notification on Fix Loop Exhausted',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_review_do_not_ship: {
    label: 'Notification on Review Do Not Ship',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_agent_run_fail: {
    label: 'Notification on Agent Run Fail',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_budget_blocked: {
    label: 'Notification on Budget Blocked',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_on_budget_exceeded: {
    label: 'Notification on Project Budget Exceeded',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_throttle_window_seconds: {
    label: 'Notification Throttle Window',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
  notification_throttle_overrides: {
    label: 'Notification Throttle Overrides',
    help: 'Not used in FIELDS; handled by NotificationsTab',
    group: 'notifications' as never,
    span: 1,
  },
}

export const DEFAULTS: Record<SettingsFieldKey, string> = {
  workspace_path: '',
  github_owner: '',
  trusted_github_users: '',
  claude_provider: 'claude',
  claude_bin: '~/.local/bin/claude',
  lmstudio_model: '',
  log_dir: './data/logs',
  frequency: '1h',
  daytime: 'false',
  weekends: 'off',
  base_prompt: 'Never ask clarifying questions. Make decisions yourself based on what you see in the codebase. If multiple approaches work, pick the simplest one and go.',
  default_model: 'fast',
  permission_mode: 'auto',
  prompt_estimate_warn_tokens: '50000',
  prompt_estimate_block_tokens: '180000',
  commit_style: 'Use conventional commits. One line only, present tense, ≤50 chars, no trailing period. Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert.',
  review_verdict_rules: `STRICT verdict rules — the user cares about code quality, not speed:
- LGTM ONLY when there are zero findings at any severity. Not "LGTM with minor notes", not "LGTM aside from a nit". If you list any "minor" / "non-blocking" / "cosmetic" / "consider..." / "nice-to-have" issue, that is NEEDS ATTENTION, not LGTM.
- NEEDS ATTENTION when you have at least one finding but nothing that risks data loss, security regressions, or breakage in production. Orphaned code, dead imports, missing imports that happen to compile, hardcoded strings that should use env vars, non-ideal UX state leaks, stylistic inconsistencies — all NEEDS ATTENTION.
- DO NOT SHIP when there is a real risk of breakage, data loss, security regression, or a test that hides behavior.
- If LGTM, just confirm the changes look good and add nothing else.`,
  fix_max_iterations: '0',
  release_min_lines: '0',
  auto_pause_unfruitful_enabled: 'true',
  auto_pause_unfruitful_runs: '6',
  release_reinforce_max_iterations: '3',
  review_fix_backoff_seconds: '30',
  review_do_not_ship_action: 'fix',
  release_wall_clock_timeout_minutes: '60',
  mark_dod_verify_timeout_ms: '600000',
  legacy_completion_hook_release_after_run_enabled: 'true',
  legacy_completion_hook_release_after_fix_ci_enabled: 'true',
  legacy_completion_hook_auto_resume_enabled: 'true',
  legacy_pipeline_lock_inline_drain_enabled: 'true',
  legacy_completion_hook_agent_drain_enabled: 'true',
  plain_test_phase_enabled: 'false',
  agent_templates: '',
  log_retention_count: '200',
  log_retention_days: '30',
  job_row_retention_days: '180',
  workflow_run_retention_days: '30',
  skill_revision_retention_count: '50',
  backup_retention_count: '14',
  backup_retention_weekly_count: '8',
  notification_webhook_url: '',
  notification_webhook_secret: '',
  notification_on_release_success: 'false',
  notification_on_release_fail: 'false',
  notification_on_release_aborted: 'false',
  notification_on_fix_loop_exhausted: 'false',
  notification_on_review_do_not_ship: 'false',
  notification_on_agent_run_fail: 'false',
  notification_on_budget_blocked: 'false',
  notification_on_budget_exceeded: 'false',
  notification_throttle_window_seconds: '900',
  notification_throttle_overrides: '{"release_fail":0,"release_aborted":0}',
  pipeline_model_review: '',
  pipeline_model_fix: '',
  pipeline_model_dod: '',
  pipeline_model_commit: '',
  project_sweep_enabled: 'false',
  dirty_worktree_block_threshold: '1',
  incremental_review_enabled: 'true',
  browser_broker_enabled: 'false',
  browser_broker_image: 'mcr.microsoft.com/playwright/mcp:v0.0.30',
  browser_broker_mode: 'docker',
  tamtam_network_policy_strict: 'false',
  orchestrator_enabled: 'false',
  orchestrator_boost_margin_pct: '5',
  orchestrator_max_boosts_per_hour: '2',
  agent_autopilot_enabled: 'true',
  initiative_engine_enabled: 'false',
  initiative_mining_enabled: 'true',
  initiative_dispatch_enabled: 'true',
  initiative_max_ships_per_day: '3',
  initiative_max_backlog_per_project: '50',
  initiative_mining_interval_minutes: '60',
}

export const COL_SPAN: Record<number, string> = { 1: 'col-span-1', 2: 'col-span-2', 3: 'col-span-3', 4: 'col-span-4' }
export const GRID_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }
