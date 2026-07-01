# Settings Reference

All settings stored in the `settings` table (key-value, both TEXT). Accessed via `lib/shared/config.ts` (`getSettings()`, `TamTamConfig`). Config is cached with a 5s TTL; `PATCH /api/settings` calls `reloadConfig()` to invalidate.

## When to read this

- Pointing tamtam at a different workspace or Claude binary
- Tuning review verdict strictness (`review_verdict_rules`)
- Changing commit message style (`commit_style`)
- Adjusting fix-CI retry behavior after flaky test failures
- Restricting agent runs to specific hours (`daytime`, `weekends`)

---

## All Keys

### Auth

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `auth_token` | write-only string | unset | Optional shared HTTP auth token. Stored as a scrypt hash in `settings`; `GET /api/settings` exposes only `auth_token_configured`. When set, every UI/API route except `/login`, `/api/health`, and `/api/auth/*` requires `Authorization: Bearer <token>` or the httpOnly `tamtam_auth` cookie. |

### Workspace

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `workspace_path` | string | `''` | Root directory scanned for git repos; drives the projects list |
| `github_owner` | string | `''` | Default GitHub org/user for repos without an explicit remote URL |
| `trusted_github_users` | JSON string array | `[]` | Global GitHub-login allowlist for trusted external issue/PR authors. Managed in Settings → General via the dedicated Trusted GitHub Users editor, stored as JSON in `settings`, unioned with each project’s `.tamtam/config.yml` `security.safe_users`, and used by untrusted-content wrapping plus trusted-only issue selection |
| `github_board_sync_enabled` | boolean | `false` | Stored as `'true'`/`'false'`. Enables GitHub Project sync for run/release lifecycle updates |
| `github_board_project_owner` | string | `''` | GitHub org/user that owns the shared TamTam project board. Falls back to `github_owner` when blank |
| `github_board_project_title` | string | `'TamTam'` | Project board title TamTam creates or reuses when sync is enabled |
| `github_board_project_number` | string | `''` | Persisted GitHub Project number discovered during provisioning |
| `github_board_project_url` | string | `''` | Persisted GitHub Project URL discovered during provisioning |
| `github_board_view_url` | string | `''` | Optional deep link to a custom GitHub Project view; UI board chips use this when set |
| `github_board_project_id` | string | `''` | Persisted GitHub Project node id discovered during provisioning |
| `github_board_status_field_id` | string | `''` | Persisted single-select field id for GitHub's built-in `Status` field |
| `github_board_status_option_ids` | JSON object | `{}` | Persisted map of board status labels to GitHub option ids |
| `github_board_custom_field_ids` | JSON object | `{}` | Persisted map of TamTam-managed text custom fields (`Project`, `Agent`, `Run kind`, `Branch`) to GitHub field ids |

### GitHub Project Board Sync

TamTam can mirror job lifecycle into a shared GitHub Project board. When enabled from Settings, TamTam uses the local `gh` CLI to create or reuse a project named by `github_board_project_title` under `github_board_project_owner`, then uses GitHub's built-in `Status` field and ensures these statuses exist:

- `Todo`
- `In Progress`
- `Review`
- `Fixing`
- `Blocked`
- `Done`

TamTam also provisions these TEXT custom fields on the project and keeps their field IDs in settings:

- `Project`
- `Agent`
- `Run kind`
- `Branch`

Prerequisites:

- `gh` must be installed and available on `PATH`
- the authenticated GitHub account must have project read/write scope for the target owner
- `github_owner` or `github_board_project_owner` must be configured before enabling sync

Provisioning behavior:

- `PATCH /api/settings` auto-provisions the board when `github_board_sync_enabled` is set to `true`
- successful provisioning writes `github_board_project_number`, `github_board_project_url`, `github_board_project_id`, `github_board_status_field_id`, `github_board_status_option_ids`, and `github_board_custom_field_ids` back into the `settings` table
- provisioning failures return HTTP 502 and do not partially enable the feature
- upgrades are backward-compatible: if an existing install still has the legacy status-option map or is missing the new custom-field IDs, the next board sync auto-reprovisions the board metadata and persists the new values without requiring a manual Settings save

Run lifecycle behavior:

- background run/release sync is best-effort and never blocks job creation or completion
- the sync metadata is stored on each root job in `context_meta.githubBoard` and includes the board item id, resolved branch name, recent activity lines, and the last-written custom-field values
- pipeline child jobs update the release root item instead of creating separate board items
- issue-linked runs prefer content-linked project items (the GitHub issue/PR itself) instead of always creating draft cards

Manual sync behavior:

- the History UI exposes `Sync board` only for finished jobs
- `POST /api/jobs/[jobId]/board-sync` is strict, not best-effort: it rejects running jobs, returns HTTP 409 when board sync is disabled or not fully configured, and returns HTTP 502 when the underlying GitHub sync fails
- manual sync reuses the existing board item when possible and refreshes the item body/status from the current persisted job state
- `POST /api/settings/board-resync` re-syncs the most recent root jobs in bulk (default last 7 days / top 100, configurable via `?days=` and `?limit=`), skips pipeline child jobs, pauses 250 ms between GitHub writes, and stops early on GitHub secondary rate limits

### CLI Routing

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `claude_provider` | string | `claude` | Legacy compatibility field. When the CLI tab saves `cli_enabled_providers`, TamTam syncs this to the first enabled provider so older “active provider” code paths keep matching the new routing model |
| `claude_bin` | string | `~/.local/bin/claude` | Legacy Claude executable path; when this is the only Claude-specific setting TamTam still routes through `scripts/claude-shim.js` and forwards the stored path via `CLAUDE_BIN` |
| `cli_enabled_providers` | string | `'claude'` | Comma-separated enabled provider set for routing top-level runs. Valid values: `claude`, `codex`, `gemini`, `lmstudio`, `deepagents` |
| `cli_bin_claude` | string | `''` | Optional underlying Claude executable path. TamTam still launches the bundled `scripts/claude-shim.js` so shared `fast` / `normal` / `smart` tiers keep working |
| `cli_bin_codex` | string | `''` | Optional underlying Codex executable path. TamTam still launches the bundled `scripts/codex-shim.js` and forwards this path via `CODEX_BIN` |
| `cli_bin_gemini` | string | `''` | Optional underlying Gemini executable path. TamTam still launches the bundled `scripts/gemini-shim.js` and forwards this path via `GEMINI_BIN` |
| `cli_bin_lmstudio` | string | `''` | Optional LM Studio server URL override. TamTam still launches the bundled `scripts/lmstudio-shim.js`; when this value looks like `http://...` or `https://...` it is forwarded via `LMSTUDIO_BASE_URL` |
| `cli_bin_deepagents` | string | `''` | Optional Deep Agents Code executable path. TamTam still launches the bundled `scripts/deepagents-shim.js` and forwards this path via `DEEPAGENTS_BIN`; when unset, the shim runs `dcode` |
| `cli_deepagents_backend` | string | `lmstudio` | Local backend used by the Deep Agents shim. Valid values: `lmstudio`, `ollama` |
| `cli_deepagents_base_url` | string | `''` | Optional local backend URL forwarded to the Deep Agents shim as `DEEPAGENTS_BASE_URL` |
| `cli_default_model_claude` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_codex` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_gemini` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_lmstudio` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_deepagents` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `provider_fallback_chain` | string | `''` | Comma-separated provider order for opt-in agent retry fallback, e.g. `codex,claude`. When an agent has `fallback_enabled=true` and the first provider exits non-zero with transient output such as 5xx, connection refused, timeout, rate limit, or quota wording, TamTam retries once with the next enabled provider in this chain and records the transition in the run log. |
| `permission_mode` | string | `auto` | Passed as `--permission-mode` for headless CLI runs. Allowed: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. Invalid values are rejected on write and normalized to `auto` on read. `auto` (recommended) is translated by the bundled Claude, Gemini, and Codex shims to provider-native non-interactive run flags; `acceptEdits` is an alternative that auto-accepts file edits; `bypassPermissions` skips all approval checks; `plan` is read-only |
| `default_model` | string | `fast` | Pre-selected semantic tier in the terminal UI. Primary options: `fast`, `normal`, `smart`. Legacy `haiku`, `sonnet`, `opus` values are still accepted and normalized. |

### Scheduling

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `frequency` | string | `1h` | Base interval for agent runs (e.g. `30m`, `1h`, `8h`) |
| `daytime` | boolean | `false` | Stored as `'true'`/`'false'`. If true, agents run 24/7; if false, night-only (20:00–05:59) |
| `weekends` | boolean | `false` | Stored as `'on'`/`'off'`. If true, agents run Sat/Sun |

### Behavior

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `base_prompt` | string | Long system prompt | Prepended to every Claude invocation — reviews, fixes, runs, agents |
| `prompt_estimate_warn_tokens` | number | `50000` | Estimated composed-prompt input-token threshold where TamTam marks a start as oversized. `0` disables warning state. Estimates use provider-aware tokenization when a caller supplies it, otherwise UTF-8 bytes / 4. |
| `prompt_estimate_block_tokens` | number | `180000` | Estimated composed-prompt input-token threshold where TamTam rejects a run before creating a job row or spawning a provider process. `0` disables hard blocking. HTTP APIs return 413 with `code: "prompt_estimate_blocked"` and `prompt_estimate`. |
| `commit_style` | string | Conventional commits guide | Injected into the push commit-message generation prompt; overridden per project by `.tamtam/config.yml` `commits.commit_style` when present |
| `review_verdict_rules` | string | Pragmatic rules | Injected into review prompts; drives LGTM / NEEDS ATTENTION / DO NOT SHIP decisions |
| `legacy_completion_hook_release_after_run_enabled` | boolean | `true` | Runtime kill switch for the legacy job-completion release-after-run hook while release triggering migrates to the workflow event router. Set to `false` to stop the completion hook without redeploying |
| `legacy_completion_hook_release_after_fix_ci_enabled` | boolean | `true` | Runtime kill switch for the legacy job-completion release-after-fix-CI hook while fix-CI release chaining migrates to the workflow event router. Set to `false` to stop the completion hook without redeploying |
| `legacy_completion_hook_auto_resume_enabled` | boolean | `true` | Runtime kill switch for the legacy job-completion auto-resume hook while interrupted run recovery migrates to the workflow event router. Set to `false` to stop the completion hook without redeploying |
| `legacy_pipeline_lock_inline_drain_enabled` | boolean | `true` | Runtime kill switch for the inline pending-release and queued-agent drain that fires when a pipeline lock is released or self-healed. Set to `false` to route lock-release recovery through durable `pipeline_lock_events` consumption instead |
| `legacy_completion_hook_agent_drain_enabled` | boolean | `true` | Runtime kill switch for the legacy job-completion hook that drains queued agent runs after an agent finishes. Set to `false` to route agent queue draining through durable `job_completion_events` consumption instead |
| `plain_test_phase_enabled` | boolean | `false` | Runtime feature flag for the release test phase. When `true`, workflow-driven releases run the detected project test command directly through `pnpm-test-phase.ts` instead of launching the Claude-driven `test-phase.ts`; failed tests still route to the same fix and re-test loop |

### Notifications

Outbound webhooks for release pipeline events. Never blocks pipeline progress — deliverability is best-effort with 3 retries.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `notification_webhook_url` | string | `''` | Webhook endpoint URL. Supports Slack (`hooks.slack.com`), Discord (`discord.com/api/webhooks`), ntfy, and generic JSON POST endpoints. Leave blank to disable notifications. |
| `notification_webhook_secret` | string | `''` | Optional secret for HMAC-SHA256 signature verification. If set, payloads include `X-TamTam-Signature` header. |
| `notification_on_release_success` | boolean | `false` | Stored as `'true'`/`'false'`. Notify when a release pipeline completes successfully. |
| `notification_on_release_fail` | boolean | `false` | Notify when a release pipeline fails. |
| `notification_on_release_aborted` | boolean | `false` | Notify when a release pipeline is aborted mid-run. |
| `notification_on_fix_loop_exhausted` | boolean | `false` | Notify when a release exhausts automated recovery budget (`test`/`review`/`commit`/`push` fix attempts) or stops for non-converging fix/review loops. |
| `notification_on_review_do_not_ship` | boolean | `false` | Notify when a code review verdict is "DO NOT SHIP". |
| `notification_on_agent_run_fail` | boolean | `false` | Notify when an agent run fails. |
| `notification_on_budget_blocked` | boolean | `false` | Notify when a run is refused because the selected agent subscription budget threshold is exceeded. |
| `notification_on_budget_exceeded` | boolean | `false` | Notify when a per-project daily or per-release spend cap blocks agent or release automation. |
| `notification_on_flaky_test_detected` | boolean | `false` | Notify when the release test step fails, retries the parsed failing vitest/pytest tests once, and the retry passes so the pipeline continues. |
| `notification_on_circuit_breaker_tripped` | boolean | `false` | Notify when the project circuit breaker auto-pauses a project after `project_failure_threshold` failed runs in the window. |
| `notification_throttle_window_seconds` | number | `900` | Suppress repeated webhook notifications with the same event/project/agent key for this many seconds. |
| `notification_throttle_overrides` | JSON object | `{ "release_fail": 0, "release_aborted": 0 }` | Per-event throttle windows in seconds. Set an event to `0` to always send. |

**Payload format:** 
- **Slack**: Formatted as block kit with event, project, status, verdict (if review), cost (if available), and a log link.
- **Discord**: Embedded message with event details and a timestamp.
- **Generic**: JSON POST with `{ event, project, job_id, status, verdict?, agent?, cost_usd?, log_url?, reason?, suppressedSince?, timestamp }`. `release_aborted` includes `reason: "wall_clock_timeout"` for automatic timeout aborts. The full event union is documented in the later **Payload shape** section below.

When a throttled event is finally sent after suppressed repeats, the payload includes `suppressedSince` and the human message includes the suppressed count.

**Test notification:** Use the "Send Test" button in the Notifications tab to verify webhook connectivity before enabling production events.

### Fix-CI Auto-Retry

All three are read live on each job (not cached), so changing them takes effect immediately.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `fix_max_iterations` | number | `0` | **Unified per-release step-retry cap.** Governs every step-verification loop the release pipeline runs: review→fix→test→review, test→fix→test, commit→fix→commit, and the review-driven push→fix→push leg. Set to `0` to run all loops until LGTM / a green test / a clean commit / a successful push (or the release wall-clock timeout aborts). `1` ships after a single failing review *and* a single failing test/commit/push; `3` is the implicit safety fallback when the setting hasn't been initialized (early boot, tests). When the review-side cap (or stuck-findings / fix-contradicts-review) trips, TamTam files a follow-up GitHub issue titled from the highest-severity structured `Finding ID` (`chore(review): <headline-finding-id> (+N more)`, the bare `Finding ID` when only one exists, or `chore(review): unresolved review` when none were extracted), tries to apply the canonical labels `tamtam` `review-followup` `priority-medium`, and skips any missing repo labels, then continues to commit + push so the partial work ships. The issue body carries the structured unresolved findings; if the review did not emit structured Finding blocks, the issue includes a quoted prose excerpt instead. The fallback issue keeps findings under `## Problem` and writes `## Acceptance criteria` as unchecked `- [ ]` checkboxes so later `mark-dod` runs can tick verified items; only the CTO issue-planning flow uses the full `Problem` / `Proposed approach` / `Acceptance criteria` template. **DO NOT SHIP** reviews are routed by the separate `review_do_not_ship_action` setting (see below). The push pre-push-hook rejection cap is intentionally separate (`getPushFixAttemptCap()`, hardcoded at 2) so a permanently failing pre-push hook can't loop forever even when this setting is 0. |
| `release_min_lines` | number | `0` | Minimum cumulative working-tree lines changed (added + removed) required before an auto-triggered release fires. `0` disables the gate (current behavior). When set, a sub-threshold agent run is **reinforced** — the same agent is re-dispatched (with a nudge prompt) to accumulate more change in the dirty working tree — instead of triggering the release pipeline. Only applies to the auto-release path (`release_after_run`), to working-tree-dirty agent jobs (not issue/PR work, not plain `run` jobs). The release fires once cumulative LOC crosses the threshold, the reinforce cap is hit, or the agent stops making progress. |
| `auto_pause_unfruitful_enabled` | boolean | `true` | When enabled, scheduled agent runs that repeatedly produce no diff and either report nothing to do or finish cleanly with exit code 0 can automatically pause the project until it is resumed from Settings. |
| `auto_pause_unfruitful_runs` | number | `6` | Consecutive no-diff scheduled runs required before auto-pausing a project, with at least one clean or explicit nothing-to-do run in the window. `0` pauses after the first qualifying run. |
| `auto_pause_unfruitful_rate` | number | `0.2` | Fruitful-rate floor (0–1) for the rate-based auto-pause trigger. A project whose recent scheduled runs change code in less than this fraction — over a wider sample (`max(auto_pause_unfruitful_runs × 2, 10)` runs, with ≥1 clean run) — is paused even without an unbroken all-no-diff window. Catches projects that grind tokens but land a diff only occasionally, which the strict consecutive-no-diff check misses. `0` disables the rate trigger, leaving only the caught-up path. |
| `release_reinforce_max_iterations` | number | `3` | Max consecutive reinforce re-runs per project before releasing whatever exists. `0` = unlimited (terminates only via the no-progress exit, where a re-run adds no new lines). Reinforce state is ephemeral (`globalThis.__tamtamReinforceState`); a restart resets the loop. |
| `review_fix_backoff_seconds` | number | `30` | Base delay, in seconds, before each review→fix iteration after the third completed review in the same release. The delay doubles on each additional round (30 → 60 → 120 → 240, capped at 300) so a slow-converging review loop does not burn tokens or CI at full speed. Set to `0` to disable the backoff entirely. |
| `review_do_not_ship_action` | enum `pass` \| `fix` \| `abort` | `fix` | What to do when a code review returns **DO NOT SHIP**. `fix` (default) routes through the same fix loop NEEDS ATTENTION uses (subject to `fix_max_iterations`). `pass` files a follow-up GitHub issue with the findings and continues to commit → push → mark-dod so the partial work still ships. `abort` keeps the legacy behavior of stopping the release immediately. |
| `release_wall_clock_timeout_minutes` | number | `60` | Overall wall-clock budget for an active Release run. Each release meta-job stores `release_deadline_at`; the 30s probe sweep aborts expired releases with reason `wall_clock_timeout`. Per-project `.tamtam/config.yml` can override this with `pipeline.release_timeout_minutes`. |
| `mark_dod_verify_timeout_ms` | number | `600000` | Wall-clock cap for the mark-dod acceptance-criteria verification job (`mark-dod-verify`). Enforced by the shared job-timeout reaper (the same one that reaps `test`), so it survives a server restart — unlike the old inline 5-min `setTimeout` it replaces. A verify job past this cap is killed (`markDone(124)`); mark-dod stays non-gating and the unchecked criteria are re-verified on a later run. |

### Runaway Guards (per-run caps + circuit breaker)

Complement the project spend budget (`daily_spend_cap_usd` / `release_spend_cap_usd`). A macro budget check can't stop a single Claude session burning tens of dollars before it fires; these caps kill the individual run, and the circuit breaker pauses a project that keeps failing. Enforced by `reapRunCapExceededJobs` / `maybeTripCircuitBreaker`, both driven off DB job rows so they survive a restart.

| Setting | Type | Default | Effect |
|---|---|---|---|
| `run_token_cap` | number | `2000000` | Kill a single run once its cumulative input+output+cache tokens exceed this. The 30s probe sweep accumulates `message.usage` from the run log (`accumulateRunTokens`) and, on a violation, kills the process group and marks the job `markDone(125)` with reason `token cap exceeded` in the log. Applies to Claude-backed runs/agents (`run`, `review`, `fix`, `fix-ci`, `pr-comment-fix`, `agent:*`); excludes `test` / `mark-dod-verify` (own hang-caps) and the `release` meta-job. `0` disables. |
| `run_wall_time_cap_minutes` | number | `30` | Kill an eligible run once its wall-clock age exceeds this, `markDone(124)` with reason `wall-time cap exceeded`. Wall-time is checked before tokens (a hung run with no new tokens still gets reaped). `0` disables. The `release` meta-job keeps its own `release_wall_clock_timeout_minutes`. |
| `project_failure_threshold` | number | `3` | After this many failed top-level runs (`run` / `release` / `agent:*` with a non-zero, non-cancelled exit) inside the window, pause the project's scheduling (`projects.paused = true`) and fire `circuit_breaker_tripped`. Trips at most once per pause window (skips if already paused). Resume from Settings once the underlying issue is fixed. `0` disables. |
| `project_failure_window_minutes` | number | `60` | Trailing window over which failed runs are counted toward `project_failure_threshold`. |

### Pipeline Model Tiers

These settings override the semantic model tier per pipeline phase. Leave a field empty to use the phase default: `pipeline_model_review` uses the workspace `default_model`, `pipeline_model_fix` uses `smart`, and `pipeline_model_dod` / `pipeline_model_commit` use `fast`.

### Orchestrator

The orchestrator budget allocator runs as a graphile-worker cron task (`orchestrator-tick`) every minute when enabled. It reads `/api/stats/bridge`, evaluates pace headroom across both the short (5h) binding window and the long (7d) weekly window, and dispatches extra scheduled-agent fires while staying inside the per-project rolling-hour cap.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `orchestrator_enabled` | boolean | `false` | Master switch for the budget allocator cron |
| `orchestrator_boost_margin_pct` | number | `5` | Minimum global pace headroom, in percentage points, required before the allocator can boost a project |
| `orchestrator_max_boosts_per_hour` | number | `2` | Per-project rolling-hour cap on bonus fires |
| `agent_autopilot_enabled` | boolean | `true` | Master switch for the role-based autopilot (throttle churning producers / downgrade idle monitors). Also gated on `orchestrator_enabled`. |
| `agent_autopilot_cadence_floor` | string | `'4h'` | Producers are never cadence-throttled past this rung |
| `agent_autopilot_tier_floor` | `fast`/`normal`/`smart` | `'fast'` | Model downgrades never go below this tier |
| `agent_autopilot_idle_streak` | number | `4` | All-clear analyses before a monitor/reviewer/planner model downgrade |
| `agent_autopilot_concern_streak` | number | `2` | Sustained loop/noise analyses before a producer cadence throttle |
| `initiative_engine_enabled` | boolean | `false` | Master switch for the autonomous initiative engine. OFF by default — autonomy is opt-in per deployment, enabled with this one toggle |
| `initiative_mining_enabled` | boolean | `true` | Whether the mining phase probes projects for chores (lint, TODOs, etc.) on each orchestrator tick. Requires `initiative_engine_enabled` |
| `initiative_dispatch_enabled` | boolean | `true` | Whether the dispatch phase starts queued initiatives through the release pipeline. Set to `false` for mine-only mode: discover and curate backlog items without auto-merge |
| `initiative_max_ships_per_day` | number | `3` | Per-project cap on autonomous merges/day so a bad streak can't flood main |
| `initiative_max_backlog_per_project` | number | `50` | Admission cap on queued backlog items per project; oldest-first promotion stops here |
| `initiative_mining_interval_minutes` | number | `60` | Minimum minutes between mining runs for the same project |

The autopilot interprets each run's value by the agent's **role** (`producer` /
`monitor` / `reviewer` / `planner` / `publisher`) and picks a role-appropriate
lever — cadence for producers, model tier for monitors/reviewers/planners,
nothing for publishers. See `docs/ORCHESTRATOR.md` → Autopilot and `docs/AGENT.md`
→ Roles.

**Decision logic** (`lib/orchestrator/budget-allocator.ts → decideBoosts`):

- **Effective margin = max(short-window margin, weekly margin).** The short window catches up first; the 7-day weekly window lags. The orchestrator keeps firing while *either* signal shows headroom above `orchestrator_boost_margin_pct`, so the weekly deficit closes even when the short window is already on pace. This is what lets the fleet "exceed flat-rate pace" to recover an underspent week — without it, boosts would stop once the 5h window caught up, leaving the weekly gap permanently open.
- **Weekly margin = max paceMarginPct across enabled providers' 7-day windows** (skipping `unknown` status). Computed in `lib/workflows/cron/orchestrator-tick-task.ts` from `bridge.globalPace.providers[*].sevenDay`.
- **Project status set:** by default the orchestrator boosts `shipping`, `active`, `idle`, and `attention` projects. When pace is *severely* under (effective slack ≥ 10pp above the floor), it widens to also include `agent_running` so the per-project queue stacks the next run behind whatever is currently in flight. `releasing`, `error`, `stuck`, and `paused` are never boosted.
- **Per-tick pick count:** 1 boost per project at the threshold, +1 per additional 10pp of slack, capped at 5 picks per project per tick (further bounded by `orchestrator_max_boosts_per_hour`).
- **Aggressive catch-up:** when effective slack ≥ 10pp, the allocator sets `modelOverride: 'smart'` on each boost decision. The orchestrator threads it through `agent-cron` → `POST /api/agents/[id]/run { model: 'smart' }` so the boosted fire runs at the smart tier regardless of the agent's stored model. Bigger model = ~3–5× tokens per call, multiplying the per-run impact when scheduling more runs alone can't close the weekly deficit before reset. Self-scheduled re-enqueues do NOT inherit the override — only the orchestrator-initiated boost fire runs at the elevated tier. The 10pp floor (just above the boost trigger itself) keeps promotion active until the workspace is essentially on pace, rather than disengaging early at a wider margin.
- **Agent cooldown:** the allocator skips agents dispatched within the last 2 minutes so back-to-back ticks don't replace a still-queued fire with a new `runAt: now()`.

**What balanced pace looks like.** When all enabled providers report `paceMarginPct < orchestrator_boost_margin_pct` on both their 5h and 7d windows, `decideBoosts` returns `[]` and the cron tick logs `no boost (pace ok or no eligible project)`. That's the steady state — the fleet's normal cron cadence carries the load without orchestrator amplification. If you observe persistent `under_pace` despite high boost volume, the bottleneck is *throughput* (per-project agent serialization caps concurrent agents at one per project) or *provider routing* (`lib/usage/cli-picker.ts` urgency formula `paceMargin / hoursLeft` can starve a provider whose window has more days remaining even when it has more absolute headroom).

**Weekly catch-up routing.** `lib/usage/cli-picker.ts` normally tapers a provider's score when its 5h window is projected above 80% utilization — the goal being to shift traffic away before the hard budget block triggers. That penalty is suppressed when the provider is materially behind on weekly pace (`paceMargin ≥ 15pp`). Rationale: when claude/7d is the under-pace window we need to burn down, shifting traffic to a different provider as claude/5h fills up is counterproductive — we *want* the 5h headroom consumed.

### Worktree & Review Gates

### Per-Project Spend Budgets

Project Config → Budget stores two optional DB-only USD caps on each project row:

| Field | Default | Effect |
|-------|---------|--------|
| `daily_spend_cap_usd` | `null` | Rolling 24h project spend cap. When current project spend is at or above the cap, new agent runs and Release starts are refused, blocked agent/release rows record `budget_exceeded`, and the `budget_exceeded` webhook event is emitted when enabled. Manual Terminal runs remain operator-driven and are not blocked by this project cap. |
| `release_spend_cap_usd` | `null` | Per-release cap. After each release child step finishes and records cost, the orchestrator sums jobs with the release id. When spend is at or above the cap, the Release stops at that phase boundary with `budget_exceeded` and emits the same webhook event. |

`0` and empty values clear the cap. The Config tab also shows read-only rolling 24h spend for the project.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `dirty_worktree_block_threshold` | number | `1` | Block agent runs (manual + scheduled) when the project has at least this many uncommitted files (incl. untracked). Default `1` means any dirty worktree blocks; raise to allow small WIP, or set to `0` to disable. Returns 409 `dirty_worktree` from `/api/agents/[id]/run`; scheduler skip-counts the fire and re-arms. |
| `incremental_review_enabled` | boolean | `true` | After an `LGTM` verdict, narrow the next pipeline review's diff to commits since that LGTM (uses `refs/tamtam/reviewed/<branch>` git ref). Falls back to `@{u}..HEAD` when the ref is missing or no longer an ancestor of HEAD. |

### Log & History Retention

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_retention_count` | number | `200` | Keep log files for the last N finished runs per project. On each run completion, the oldest log files beyond this count are deleted and the DB row is flagged `log_pruned`. Set to `0` to disable count-based pruning. |
| `log_retention_days` | number | `30` | Delete log files older than this many days (per project, evaluated on each run completion). Set to `0` to disable age-based pruning. |
| `job_row_retention_days` | number | `180` | Nightly cleanup: delete finished `jobs` DB rows older than this many days. Set to `0` to disable. Run rows older than this threshold are permanently removed. |
| `workflow_run_retention_days` | number | `30` | Nightly cleanup: delete completed workflow runtime traces older than this many days. With `WORKFLOW_TARGET_WORLD=local` (the default), this prunes files under `WORKFLOW_LOCAL_DATA_DIR` / `data/workflow-data`; with a Postgres workflow world, this prunes the workflow runtime tables. Set to `0` to disable. |
| `skill_revision_retention_count` | number | `50` | Nightly cleanup: keep this many newest `skill_revisions` and `agent_revisions` rows per skill/agent. Set to `0` to disable revision pruning. |
| `backup_retention_count` | number | `14` | Keep this many newest Postgres `tamtam-*.pgdump` backup files after each successful backup. Set to `0` to prune all older backups after each run while still keeping the newly created backup. |
| `backup_retention_weekly_count` | number | `8` | Keep one additional older Postgres backup per week for this many weeks after the newest backups. The just-created backup is preserved separately and does not consume one of these weekly slots. Set to `0` to disable weekly retention. |

Retention writes separate latest-summary records to `maintenance_status`: `retention:project-logs:last` for per-project log pruning and `retention:nightly:last` for nightly row cleanup. The nightly record includes row counts and errors from the `jobs` row purge so the monitoring API can still report the most recent database maintenance result even after later run completions trigger log pruning.

### System

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_dir` | string | `./data/logs` | Directory where job log files are written |
| `launchagent_prefix` | string | `com.tamtam` | Prefix for macOS LaunchAgent plist filenames |

### Retrieval

Semantic retrieval layer — embeds agent run reports plus project-scoped knowledge into the `retrieval_chunks` table (a pgvector-backed column on the same Postgres database TamTam uses for everything else) and injects relevant context into agent prompts at run time. The corpus includes committed project docs, DB-backed skills referenced by that project's agents, and synthesized project config guidance. Embeddings are generated locally via Ollama (`nomic-embed-text`). Enabled by default; toggle and tune from Settings → General → "Retrieval (Embeddings)". Trigger a per-project corpus rebuild from the project's Config tab → "Reindex now"; current chunk/record counts are surfaced via `GET /api/projects/[schedId]/retrieval/stats`.

| Key | Type | Default | Description |
|---|---|---|---|
| `retrieval_enabled` | bool | `true` | Master gate — nothing runs if off |
| `retrieval_ollama_url` | string | `http://localhost:11434` | Ollama base URL |
| `retrieval_embedding_model` | string | `nomic-embed-text` | Ollama embedding model name |
| `retrieval_context_limit` | int | `5` | Max snippets injected per agent prompt |
| `retrieval_score_threshold` | float | `0.8` | Min similarity score to include a result |
| `retrieval_manage_ollama` | bool | `true` | Whether TamTam starts Ollama via PM2 if not running |

When enabled, TamTam starts Ollama via PM2 (`ollama-serve`) on boot if not already reachable, pulls `nomic-embed-text` if not installed, and indexes completed agent run reports automatically. Use `POST /api/projects/[schedId]/retrieval/reindex` to refresh the project corpus on demand; that route reports whether sources were missing or stale before the refresh. Freshness behavior is source-specific: completed agent runs are indexed when they finish, while project docs, DB-backed skills, and synthesized project config are refreshed on explicit reindex against the current file/DB snapshot. At prompt time, TamTam records retrieval diagnostics on the run (`results`, `empty_corpus`, `no_results`, `below_threshold`, or `embed_failed`) so ineffective retrieval can be distinguished from a healthy hit.

#### Built-in documentation-reindex-vectors agent

A `kind='system'` agent named `documentation-reindex-vectors` is auto-seeded for every enabled project. It is a built-in TamTam agent — visible in `/agents` and the project's agents tab with a `system` badge, scheduled by the same graphile-worker cron pipeline as user agents (default `16h`), and surfaced in `/workflow-runs` like any other run. It does **not** spawn a CLI; the scheduled tick dispatches to an internal handler in `lib/agents/system/retrieval-maintenance.ts`.

Each fire does three things deterministically and finishes with a cheap-LLM quality check:

1. **Detects embedding-model drift.** Compares each `retrieval_records.embedding_model` for the project against the current `retrieval_embedding_model` setting. If any record was indexed with a different model, the entire project's chunks + records are wiped before the reindex (old-dim vectors can't be safely searched against new-model queries).
2. **Reindexes the project corpus** via `reindexProject()` (`lib/agents/retrieval/reindex-project.ts`) — the same code path the manual `POST /api/projects/[schedId]/retrieval/reindex` route uses. Content-hash dedup (`retrieval_records.content_hash`) skips unchanged sources without re-embedding, so the happy-path cost is roughly proportional to what actually changed.
3. **Verifies retrieval quality** by issuing a sample query (the first H1 from `CLAUDE.md` / `README.md`, falling back to `<project> overview`), pulling the top-5 results, and, when `outcome_classifier_model` is non-empty, asking a small local LLM (default `gemma3:4b` on the existing retrieval Ollama) whether the snippets look like real on-topic project content. The verdict (`ok` | `problem` | `null` when the verifier is unreachable or not configured) lands on the run's `contextMeta.retrievalHealth` along with reindex stats. Verifier failure does **not** fail the run.

Settings hook: editing `retrieval_embedding_model` in `/settings/general` enqueues an immediate `documentation-reindex-vectors` run for every project so the rebuild starts at once instead of waiting up to one schedule interval. The handler detects the mismatch and wipes via the same code path.

Operator controls:

- **Enabled** is editable from the standard agents UI per project. Schedule is managed globally from Settings -> Retrieval via `retrieval_reindex_interval_hours`. Other fields (name, prompt, skills, prereq, model, provider) are locked — the agent is auto-managed.
- **Disable** removes scheduled runs but keeps the row.
- **Delete** writes a `system_agent_dismissed:<project>:documentation-reindex-vectors` settings marker so the seeder does not recreate it on next boot. To re-enable, delete that settings key.
- **Manual reindex** via the existing project Config tab → "Reindex now" continues to work and uses the same `reindexProject()` function.

Known caveats:

- A run that completes before this system agent fires still indexes its own agent_run chunk (existing behavior), but the doc/skill/config corpus only refreshes on the agent's schedule. To force a refresh sooner: lower `retrieval_reindex_interval_hours` in Settings -> Retrieval momentarily, or hit the manual reindex endpoint.
- `GET /api/projects/[schedId]/retrieval/stats` still returns counts only; per-source missing/stale status comes from each maintenance run's `contextMeta.retrievalHealth` or from a fresh manual reindex.

### Outcome Classifier

After a `run` or `agent:*` job finishes, TamTam optionally classifies the final assistant message via a small local LLM (default `gemma3:4b`) on the same Ollama instance configured under Retrieval (`retrieval_ollama_url`). The verdict (`done` / `needs_continue` / `asked_question`) is stashed on the job's `contextMeta.outcomeClassification` and surfaced by the run history UI to highlight when Continue should be offered even on a clean exit.

| Key | Type | Default | Description |
|---|---|---|---|
| `outcome_classifier_enabled` | bool | `false` | When on, classify finished `run`/`agent:*` outcomes. Requires Ollama reachable at `retrieval_ollama_url`. Off by default to avoid per-job warnings when Ollama isn't running. |
| `outcome_classifier_model` | string | `gemma3:4b` | Ollama model used for classification. Must already be pulled on the configured Ollama. |

### Durable Agent Workflows

All agent runs go through the workflow intake (`runPrerequisiteStep` → `composePromptStep` → `startAgentStep`). There is no setting and no alternate path; the workflow owns prompt composition, retrieval/memory injection, and the spawn handoff. See `docs/AGENT.md` → "Durable Agent Intake" for the step-level breakdown.

Default: TamTam uses the workflow runtime's local world (`WORKFLOW_TARGET_WORLD=local`) and stores runtime traces under `WORKFLOW_LOCAL_DATA_DIR` or `data/workflow-data`. `scripts/pm2-start.sh`, `ecosystem.config.js`, and `next.config.ts` set this default when the environment does not provide a workflow target.

Override: operators who intentionally run a Postgres-backed workflow world must set the workflow runtime target and provide that world's Postgres setup/connection environment. The main TamTam application database still uses `DATABASE_URL`. The workflow world starts automatically on TamTam boot when `WORKFLOW_TARGET_WORLD` is set; if it fails to start or enqueue a run, agent runs return `500 { detail: "Workflow failed to enqueue: …" }`.

### Subscription Budget

Live subscription quota (5-hour rolling + 7-day weekly window) is surfaced on `/stats` and Settings → Budget. For the `claude` provider, TamTam fetches `https://api.anthropic.com/api/oauth/usage` using the OAuth token from the macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) or `~/.claude/.credentials.json` and caches the snapshot for 600 s. The background budget-recovery ticker refreshes that cache every 300 s before checking whether queued work can resume. For the `codex` provider, TamTam reads the latest local Codex `token_count.rate_limits` event from `~/.codex/sessions/**/*.jsonl`, matching the windows shown by Codex `/status`. Successful provider snapshots are also stored as hidden `quota_snapshot:<provider>` rows in the `settings` table so quota widgets and global pace can show last-known values after a restart or upstream rate limit.

Quota visibility is best-effort. Missing OAuth credentials, cold local Codex session data, Anthropic rate-limit backoff, or other first-fetch failures are reported to the UI as a typed unavailable state; dashboards keep rendering and show unobtrusive "quota unavailable" copy. Once a provider has produced a successful snapshot, later refresh failures reuse the in-memory or persisted snapshot with `stale: true` until a fresh read succeeds.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `budget_block_runs_enabled` | boolean | `false` | Enables the legacy active-provider budget gate. The multi-provider chooser always routes around exhausted quota-backed providers before starting any run/release path; if every enabled quota-backed provider is at or above `budget_block_at_pct`, pipeline routes (`run`, `review`, `fix`, `push`, `release`, `rerun`, `fix-ci`, `agent run`) return HTTP 429 without toggling `jobs_paused` |
| `budget_block_on_weekly_pace_enabled` | boolean | `true` | When true, the hard budget gate also treats 7-day utilization at or above `budget_block_at_pct` as blocked. Set to false to gate only the immediate 5-hour window and provider credits |
| `budget_subscription_providers` | string | `'claude,codex'` | Comma-separated provider list shown in Settings → Budget and `/stats` so TamTam tracks pace for each selected subscription |
| `budget_block_at_pct` | number | `95` | Block threshold in percent (0–100). Applies to the hard 5-hour window, provider credits, and 7-day utilization when `budget_block_on_weekly_pace_enabled` is true. Scheduled agents separately consult the 7-day burn-rate throttle in the internal scheduler |
| `budget_warn_at_pct` | number | `80` | Cosmetic warn threshold; quota bars turn yellow at this percentage |

Budget gate semantics:

- The provider chooser is the single source of truth for budget blocking.
- A single enabled provider is still blocked once its own 5-hour/credits quota crosses `budget_block_at_pct`; when `budget_block_on_weekly_pace_enabled` is true, the same threshold also applies to 7-day utilization.
- With multiple enabled providers, TamTam skips blocked providers and uses the enabled provider with the most remaining headroom.
- Exhausted quota is a transient start-gate rejection, not a manual pause. It does not write `jobs_paused=true`; queued work retries through the normal recovery paths once provider headroom returns.
- Agent `provider` preferences are soft: TamTam uses them when they are enabled and healthy, otherwise it falls back to the normal chooser.
- Release/test/push entrypoints use the same chooser up front, so a full legacy `claude_provider` snapshot does not block work when another enabled provider is still healthy.
- The weekly burn-rate throttle is enforced only for scheduled agent fires via `scheduledBurnRateBlocked()` in the internal scheduler; manual buttons and root pipeline starts do not 429 on projected 7-day pace alone. The separate `budget_block_on_weekly_pace_enabled` setting controls whether actual 7-day utilization is part of the hard start gate.

#### Pace-aware provider routing (requirement)

TamTam must decide which CLI provider an agent run targets based on **current pace**, not on the agent's name or its declared `model:`. The agent's model alias (sonnet/opus/gpt-5/gemini-2) is a hint about *capability tier*, not provider routing.

The chooser identifies whichever enabled provider is *most behind expected pace* (largest `paceMarginPct` from `bridge.globalPace.providers`) and routes the run to the provider with the most remaining budget headroom to spend toward that catch-up — i.e. when pace is suffering on provider X, prefer the provider where we currently have more tokens to burn so the under-pace condition resolves fastest. This avoids the greedy "always pick max headroom" behavior, which starves any provider that has already burned half its window even when it remains the one we *need* to keep using to hit our weekly allocation.

This applies to every routing decision that doesn't have an explicit `provider:` override on the agent or job, including: agent intake, terminal runs, pipeline phase dispatch, orchestrator boost fires, and rerun. The model alias never influences provider choice; agents named `docs-claude` or `improve-codex` are conventions, not routing directives.

**Pace override behavior:**

When an agent or run has an explicit `provider:` preference and `budget_block_runs_enabled` is **false**, TamTam will override that preference if another enabled provider is *urgently* behind on pace. The urgency is calculated per-provider as `paceMarginPct / hoursLeftInWindow`, capturing the catch-up *rate* (percentage points per hour) required to hit the 7-day pace target before the window resets. When any enabled provider has urgency ≥ 1.0 pp/hour and exceeds the preferred provider's urgency, the run uses the most-urgent provider instead.

That urgency is then damped by remaining total headroom so a provider with under 10 percentage points of total quota left does not win the chooser on weekly-catch-up pressure alone. At that point the router should favor the provider that can both catch up and still spend useful budget without immediately crowding the cap.

**Example:** Provider A is 35pp behind pace with 24 hours left (1.46 pp/h urgency). Provider B is 35pp behind with 5 days left (0.29 pp/h urgency). An agent pinned to provider B will be rerouted to provider A because A is ~5× more urgent. Operator can disable this by enabling `budget_block_runs_enabled` (which applies a hard gate instead) or by pausing runs (`jobs_paused`) to avoid auto-reroute mid-flow.

#### Review-fix backoff (default: 30 seconds)

When a review returns a NEEDS ATTENTION or DO NOT SHIP verdict, TamTam dispatches a fix phase. If fix fails its CI checks and another review is needed, the next fix dispatch is delayed by `review_fix_backoff_seconds` using exponential backoff: iteration N waits `base * 2^(N-2)` seconds. The default of 30 seconds means iteration 4 waits 30s, iteration 5 waits 60s, iteration 6 waits 120s, etc., capped at 8 minutes. Set to 0 to disable the backoff and allow rapid re-tries (useful for flaky CI that self-heals quickly). See `dispatch-phase.ts` for the backoff schedule and cap.

#### Stats bridge bootstrap requirement

The `/api/stats/bridge` endpoint must be running for TamTam's observability features to work correctly. The usage snapshot cron task (`usage-snapshot`) fetches bridge state every 5 minutes to record hourly pace metrics. If this endpoint is unavailable, the cron task will fail gracefully (logged as a warning, retried up to 5 times) and the usage history chart will show no data. No TamTam core features are blocked by this, but the observability dashboard will be incomplete. To verify the endpoint is available, check `/api/stats/bridge` returns HTTP 200 with a `globalPace.providers` array.
- Agent runs that were queued behind an active release lock or an older `pending_release` stay persisted in `queued_agent_runs` if replay hits a temporary 429 budget block; they are retried when the budget recovers, when jobs resume from pause, on boot, and by the periodic queued-agent recovery sweep.
- `jobs_paused` blocks scheduled agent runs, pipeline steps, reruns, and CI-fix starts. It does **not** block manual terminal runs (`POST /api/projects/by-project/[name]/run`) or manually-triggered agent runs (`POST /api/agents/[id]/run` without `x-tamtam-trigger: schedule`); those two entry-points bypass the gate so operators can always run things interactively even while the pipeline is paused.
- `rebuild_in_progress` is a UI-only sentinel set by `scripts/rebuild-safe.sh` alongside `jobs_paused=true` and cleared on unpause. The top-menu chip renders "rebuilding…" with a spinner instead of the ambiguous "jobs paused" while the flag is on, and the click handler is disabled so an operator cannot accidentally unpause mid-rebuild. Cleared by the script's EXIT trap on any failure path so the chip never lies about an active rebuild after the script has bailed.

**Payload shape** (generic JSON POST):

```typescript
{
  event:
    | 'release_success'
    | 'release_fail'
    | 'release_aborted'
    | 'fix_loop_exhausted'
    | 'review_do_not_ship'
    | 'agent_run_fail'
    | 'budget_blocked'
    | 'budget_exceeded'
    | 'post_merge_revert';
  project: string;
  agent?: string;         // set for agent_run_fail and agent budget_exceeded events
  job_id: string;
  status: 'success' | 'failed';
  verdict?: string;       // set for review events
  cost_usd?: number;
  log_url?: string;       // link to /project/<name>/history; driven by TAMTAM_BASE_URL env
  message?: string;
  timestamp: number;      // ms since epoch
}
```

**Signature verification** (when `notification_webhook_secret` is set):

```js
const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
const isValid = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-tamtam-signature']));
```

**Adapter detection** (automatic, based on URL):

| URL pattern | Format |
|-------------|--------|
| `hooks.slack.com` | Slack Block Kit |
| `discord.com/api/webhooks` | Discord embed |
| anything else | Raw JSON (works for ntfy, custom receivers) |

**Retry**: 3 attempts, exponential backoff (1s → 2s → 4s). Failures are logged and never block pipeline progress.

**Test button**: Settings → Notifications tab → "Send Test" fires a synthetic `release_success` payload immediately.

### Templates

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `agent_templates` | string (JSON) | `''` | JSON array of `AgentTemplateRecord[]`; managed via the Templates tab in Settings |

`AgentTemplateRecord` shape:
```typescript
{
  name: string         // template identifier
  description: string
  model: string        // 'fast' | 'normal' | 'smart' (legacy 'haiku' | 'sonnet' | 'opus' still accepted)
  schedule: string     // '' (manual) | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '24h' | '3d' | '7d' | '30d'
  prompt: string
  skillIds?: string[]
}
```

---

## API

**GET `/api/settings`** — returns `{ settings: Record<string, string> }` with all current pairs.

**PATCH `/api/settings`** — accepts a partial object; writes changed keys to DB, deletes null/empty values, invalidates cache. Only keys in `SETTING_KEYS` are accepted:

```
github_owner, github_board_sync_enabled, github_board_project_owner,
github_board_project_title, github_board_project_number, github_board_project_url,
github_board_view_url, github_board_project_id, github_board_status_field_id,
github_board_status_option_ids, github_board_custom_field_ids,
trusted_github_users,
claude_provider, claude_bin, lmstudio_model, cli_enabled_providers,
cli_bin_claude, cli_bin_codex, cli_bin_gemini, cli_bin_lmstudio,
cli_bin_deepagents, cli_deepagents_backend, cli_deepagents_base_url,
cli_default_model_claude, cli_default_model_codex,
cli_default_model_gemini, cli_default_model_lmstudio,
cli_default_model_deepagents, log_dir,
frequency, daytime, weekends, launchagent_prefix, workspace_path,
base_prompt, default_model, permission_mode, commit_style,
review_verdict_rules, jobs_paused,
fix_max_iterations, release_min_lines, auto_pause_unfruitful_enabled,
auto_pause_unfruitful_runs, auto_pause_unfruitful_rate, release_reinforce_max_iterations,
release_wall_clock_timeout_minutes, mark_dod_verify_timeout_ms,
run_token_cap, run_wall_time_cap_minutes,
project_failure_threshold, project_failure_window_minutes,
legacy_completion_hook_release_after_run_enabled,
legacy_completion_hook_release_after_fix_ci_enabled,
legacy_completion_hook_auto_resume_enabled,
legacy_pipeline_lock_inline_drain_enabled,
legacy_completion_hook_agent_drain_enabled,
plain_test_phase_enabled,
agent_templates, log_retention_count, log_retention_days,
job_row_retention_days, workflow_run_retention_days,
skill_revision_retention_count, backup_retention_count, backup_retention_weekly_count,
notification_webhook_url,
notification_webhook_secret, notification_on_release_success,
notification_on_release_fail, notification_on_release_aborted,
notification_on_fix_loop_exhausted, notification_on_review_do_not_ship,
notification_on_agent_run_fail, notification_on_budget_blocked,
notification_on_budget_exceeded, notification_on_circuit_breaker_tripped,
notification_throttle_window_seconds, notification_throttle_overrides,
budget_block_runs_enabled, budget_subscription_providers,
budget_block_at_pct, budget_warn_at_pct, pipeline_model_review,
pipeline_model_fix, pipeline_model_dod, pipeline_model_commit,
dirty_worktree_block_threshold, incremental_review_enabled,
retrieval_enabled, retrieval_ollama_url, retrieval_embedding_model,
retrieval_context_limit, retrieval_score_threshold, retrieval_manage_ollama,
outcome_classifier_enabled, outcome_classifier_model
```

**POST `/api/settings/test-notification`** — sends a test notification to verify webhook connectivity. Request body: `{ webhook_url: string, webhook_secret?: string }`. Response: `{ ok: boolean, error?: string }`.

---

## Per-project config (not in `settings` table)

These live on the `projects` table row, accessed via `GET/PATCH /api/projects/by-project/[name]/config`:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `testCommand` | string | `''` | Command run by the test step; auto-detected from `package.json`/`Makefile`/etc. if blank |
| `autoCommitEnabled` | boolean | `false` | During a Release pipeline run, automatically commit staged changes after tests pass (skips the manual commit confirmation step) |
| `autoPushEnabled` | boolean | `false` | During a Release pipeline run, automatically push after commit without requiring manual confirmation. Also enables pipeline chaining (test→review→fix→push) outside of a formal Release run |
| `testCronEnabled` | boolean | `false` | Scheduled test runs |
| `testCronSchedule` | string | `''` | Cron interval for scheduled tests |
| `website` | string | `''` | Public URL the QA agent browses when no explicit QA target is configured |
| `qaUrl` | string | `''` | Explicit QA target URL that takes precedence over `website` |
| `customActions` | JSON | `[]` | Per-project buttons (name, command, color) shown in the UI |

The same config endpoint also exposes file-backed team-contract values from `.tamtam/config.yml`. `commit_style` is written under `commits.commit_style`; when present it overrides the global `settings.commit_style` for auto-generated commit messages in that project, and an empty value removes the project override.

---

## Quick Reference

### Common configuration scenarios

| Goal | Setting(s) to change |
|------|----------------------|
| Point to a different workspace | `workspace_path` |
| Use a different Claude binary | `claude_bin` |
| Make reviews more lenient | `review_verdict_rules` — soften NEEDS ATTENTION criteria |
| Use conventional commits | `commit_style` — already the default |
| Run agents 24/7 (not just nights) | `daytime = true` |
| Run agents on weekends | `weekends = on` |
| Cap or uncap every step-verification loop (review, test, commit, push) | `fix_max_iterations` — the single global step-retry knob. `0` = unlimited (run until success; the release wall-clock timeout is the outer safety bound); `1` = ship/abort after a single failing verification of each step; any `N ≥ 1` caps every step at N |
| Faster polling after a run | Handled automatically by `startFastPolling()` in UI |

### Settings that take effect immediately vs on next run

| Immediate (no restart) | Next job only |
|-----------------------|---------------|
| `fix_max_iterations` | `base_prompt`, `commit_style`, `review_verdict_rules` (read at job start) |
| `workspace_path` (next projects scan) | `claude_bin`, `permission_mode` (read at job start) |

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Projects list empty | `workspace_path` not set or wrong path | Go to Settings → set workspace path |
| Claude not found | `claude_bin` path wrong | Verify with `which claude` and update the setting |
| Reviews always pass | `review_verdict_rules` too permissive | Tighten the rules in Settings → Behavior |
| Reviews keep churning until cap, never landing | `fix_max_iterations` too high for the project | Lower to `2` or `1`; partial work still ships and a follow-up issue is filed |
| Reviews / tests / commits keep running until timeout | `fix_max_iterations = 0` disables every step cap | Set a finite cap such as `1` or `2` if you want the loop to stop before timeout |
| Agents run during the day unexpectedly | `daytime = true` | Set `daytime = false` for night-only |
