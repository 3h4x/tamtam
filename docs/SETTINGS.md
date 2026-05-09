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

### Workspace

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `workspace_path` | string | `''` | Root directory scanned for git repos; drives the projects list |
| `github_owner` | string | `''` | Default GitHub org/user for repos without an explicit remote URL |
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
| `cli_enabled_providers` | string | `'claude'` | Comma-separated enabled provider set for routing top-level runs. Valid values: `claude`, `codex`, `gemini`, `lmstudio` |
| `cli_bin_claude` | string | `''` | Optional underlying Claude executable path. TamTam still launches the bundled `scripts/claude-shim.js` so shared `fast` / `normal` / `smart` tiers keep working |
| `cli_bin_codex` | string | `''` | Optional underlying Codex executable path. TamTam still launches the bundled `scripts/codex-shim.js` and forwards this path via `CODEX_BIN` |
| `cli_bin_gemini` | string | `''` | Optional underlying Gemini executable path. TamTam still launches the bundled `scripts/gemini-shim.js` and forwards this path via `GEMINI_BIN` |
| `cli_bin_lmstudio` | string | `''` | Optional LM Studio server URL override. TamTam still launches the bundled `scripts/lmstudio-shim.js`; when this value looks like `http://...` or `https://...` it is forwarded via `LMSTUDIO_BASE_URL` |
| `cli_default_model_claude` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_codex` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_gemini` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `cli_default_model_lmstudio` | string | `normal` | Per-provider default tier, normalized to `fast` / `normal` / `smart`; used by launch paths that do not receive an explicit model override |
| `permission_mode` | string | `bypassPermissions` | Passed as `--permission-mode` flag. Allowed: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan` — invalid values fall back to `bypassPermissions` |
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
| `commit_style` | string | Conventional commits guide | Injected into the push commit-message generation prompt; overridden per project by `.tamtam/config.yml` `commits.commit_style` when present |
| `review_verdict_rules` | string | Pragmatic rules | Injected into review prompts; drives LGTM / NEEDS ATTENTION / DO NOT SHIP decisions |

### Notifications

Outbound webhooks for release pipeline events. Never blocks pipeline progress — deliverability is best-effort with 3 retries.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `notification_webhook_url` | string | `''` | Webhook endpoint URL. Supports Slack (`hooks.slack.com`), Discord (`discord.com/api/webhooks`), ntfy, and generic JSON POST endpoints. Leave blank to disable notifications. |
| `notification_webhook_secret` | string | `''` | Optional secret for HMAC-SHA256 signature verification. If set, payloads include `X-TamTam-Signature` header. |
| `notification_on_release_success` | boolean | `false` | Stored as `'true'`/`'false'`. Notify when a release pipeline completes successfully. |
| `notification_on_release_fail` | boolean | `false` | Notify when a release pipeline fails. |
| `notification_on_release_aborted` | boolean | `false` | Notify when a release pipeline is aborted mid-run. |
| `notification_on_fix_loop_exhausted` | boolean | `false` | Notify when a release exhausts automated recovery budget (`test`/`review` retries or `fix-push` attempts) or stops for non-converging fix/review loops. |
| `notification_on_review_do_not_ship` | boolean | `false` | Notify when a code review verdict is "DO NOT SHIP". |
| `notification_on_agent_run_fail` | boolean | `false` | Notify when an agent run fails. |
| `notification_on_budget_blocked` | boolean | `false` | Notify when a run is refused because the selected agent subscription budget threshold is exceeded. |

**Payload format:** 
- **Slack**: Formatted as block kit with event, project, status, verdict (if review), cost (if available), and a log link.
- **Discord**: Embedded message with event details and a timestamp.
- **Generic**: JSON POST with `{ event, project, job_id, status, verdict?, agent?, cost_usd?, log_url?, timestamp }`. The full event union is documented in the later **Payload shape** section below.

**Test notification:** Use the "Send Test" button in the Notifications tab to verify webhook connectivity before enabling production events.

### Fix-CI Auto-Retry

All three are read live on each job (not cached), so changing them takes effect immediately.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `review_fix_max_iterations` | number | `3` | Cap on **NEEDS ATTENTION** review→fix verification rounds per release. It applies only to the review-side recovery loop. When the cap (or stuck-findings / fix-contradicts-review) trips, TamTam files a follow-up GitHub issue titled from the highest-severity structured `Finding ID` (`chore(review): <headline-finding-id> (+N more)`, the bare `Finding ID` when only one exists, or `chore(review): unresolved review` when none were extracted), tries to apply the canonical labels `tamtam` `review-followup` `priority-medium`, and skips any missing repo labels, then continues to commit + push so the partial work ships. The issue body carries the structured unresolved findings; if the review did not emit structured Finding blocks, the issue includes a quoted prose excerpt instead. The fallback issue keeps findings under `## Problem` and writes `## Acceptance criteria` as unchecked `- [ ]` checkboxes so later `mark-dod` runs can tick verified items; only the CTO issue-planning flow uses the full `Problem` / `Proposed approach` / `Acceptance criteria` template. **DO NOT SHIP** reviews are not downgraded by this setting; they still stop the release before commit/push. Test/commit/push safety caps still come from the shared env guard (`TAMTAM_MAX_STEP_ITERATIONS`). |

### Worktree & Review Gates

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `dirty_worktree_block_threshold` | number | `20` | Block agent runs (manual + scheduled) when the project has at least this many uncommitted files (incl. untracked). Returns 409 `dirty_worktree` from `/api/agents/[id]/run`; scheduler skip-counts the fire and re-arms. Set to `0` to disable. |
| `incremental_review_enabled` | boolean | `true` | After an `LGTM` verdict, narrow the next pipeline review's diff to commits since that LGTM (uses `refs/tamtam/reviewed/<branch>` git ref). Falls back to `@{u}..HEAD` when the ref is missing or no longer an ancestor of HEAD. |

### Log & History Retention

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_retention_count` | number | `200` | Keep log files for the last N finished runs per project. On each run completion, the oldest log files beyond this count are deleted and the DB row is flagged `log_pruned`. Set to `0` to disable count-based pruning. |
| `log_retention_days` | number | `30` | Delete log files older than this many days (per project, evaluated on each run completion). Set to `0` to disable age-based pruning. |
| `job_row_retention_days` | number | `180` | Nightly cleanup: delete finished `jobs` DB rows older than this many days. Set to `0` to disable. Run rows older than this threshold are permanently removed. |

### System

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `log_dir` | string | `./data/logs` | Directory where job log files are written |
| `launchagent_prefix` | string | `com.tamtam` | Prefix for macOS LaunchAgent plist filenames |

### Notifications

Outbound webhook fired when the release pipeline reaches a terminal state. Supports Slack incoming webhooks, Discord webhooks, and any generic HTTP receiver (e.g. ntfy).

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `notification_webhook_url` | string | `''` | Destination URL; auto-detected as Slack / Discord / generic by URL pattern |
| `notification_webhook_secret` | string | `''` | If set, every POST includes an `X-TamTam-Signature` HMAC-SHA256 hex header over the JSON body |
| `notification_on_release_success` | boolean | `false` | Fire when the full release pipeline completes with exit 0 |
| `notification_on_release_fail` | boolean | `false` | Fire when any pipeline step fails and the pipeline halts |
| `notification_on_fix_loop_exhausted` | boolean | `false` | Fire when a release exhausts automated recovery budget (`test`/`review` retries or `fix-push` attempts) or stops because fix/review iterations are not converging |
| `notification_on_review_do_not_ship` | boolean | `false` | Fire when a review returns a DO NOT SHIP verdict |
| `notification_on_agent_run_fail` | boolean | `false` | Fire when any scheduled agent job exits non-zero |
| `notification_on_budget_blocked` | boolean | `false` | Fire when a run is refused because the selected agent subscription budget threshold is exceeded (debounced once per window+resetsAt) |

### Subscription Budget

Live subscription quota (5-hour rolling + 7-day weekly window) is surfaced on `/stats` and Settings → Budget. For the `claude` provider, TamTam fetches `https://api.anthropic.com/api/oauth/usage` using the OAuth token from the macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) or `~/.claude/.credentials.json` and caches the snapshot for 180 s. For the `codex` provider, TamTam reads the latest local Codex `token_count.rate_limits` event from `~/.codex/sessions/**/*.jsonl`, matching the windows shown by Codex `/status`.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `budget_block_runs_enabled` | boolean | `false` | When true, TamTam resolves a provider through the enabled CLI set before starting any run/release path. If every enabled provider is at or above `budget_block_at_pct`, pipeline routes (`run`, `review`, `fix`, `push`, `release`, `rerun`, `fix-ci`, `agent run`) return HTTP 429 |
| `budget_subscription_providers` | string | `'claude,codex'` | Comma-separated provider list shown in Settings → Budget and `/stats` so TamTam tracks pace for each selected subscription |
| `budget_block_at_pct` | number | `95` | Block threshold in percent (0–100). Applies to the hard 5-hour window; scheduled agents separately consult the 7-day burn-rate throttle in the internal scheduler |
| `budget_warn_at_pct` | number | `80` | Cosmetic warn threshold; quota bars turn yellow at this percentage |

Budget gate semantics:

- The provider chooser is the single source of truth for budget blocking.
- A single enabled provider is still blocked once its own 5-hour/credits quota crosses `budget_block_at_pct`.
- With multiple enabled providers, TamTam skips blocked providers and uses the enabled provider with the most remaining headroom.
- Agent/file-agent `provider` preferences are soft: TamTam uses them when they are enabled and healthy, otherwise it falls back to the normal chooser.
- Release/test/push entrypoints use the same chooser up front, so a full legacy `claude_provider` snapshot does not block work when another enabled provider is still healthy.
- The weekly burn-rate throttle is enforced only for scheduled agent fires via `scheduledBurnRateBlocked()` in the internal scheduler; manual buttons and root pipeline starts do not 429 on projected 7-day pace alone.
- Agent runs that were queued behind an active release lock or an older `pending_release` stay persisted in `queued_agent_runs` if replay hits a temporary 429 budget block; they are retried when the budget recovers, when jobs resume from pause, on boot, and by the periodic queued-agent recovery sweep.
- `jobs_paused` blocks scheduled agent runs, pipeline steps, reruns, and CI-fix starts. It does **not** block manual terminal runs (`POST /api/projects/by-project/[name]/run`) or manually-triggered agent runs (`POST /api/agents/[id]/run` without `x-tamtam-trigger: schedule`); those two entry-points bypass the gate so operators can always run things interactively even while the pipeline is paused.

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
    | 'budget_blocked';
  project: string;
  agent?: string;         // set for agent_run_fail events
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
  runner: string       // 'pm2' | 'launchctl'
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
claude_provider, claude_bin, lmstudio_model, cli_enabled_providers,
cli_bin_claude, cli_bin_codex, cli_bin_gemini, cli_bin_lmstudio,
cli_default_model_claude, cli_default_model_codex,
cli_default_model_gemini, cli_default_model_lmstudio, log_dir,
frequency, daytime, weekends, launchagent_prefix, workspace_path,
base_prompt, default_model, permission_mode, commit_style,
review_verdict_rules, jobs_paused,
review_fix_max_iterations,
agent_templates, log_retention_count, log_retention_days,
job_row_retention_days, notification_webhook_url,
notification_webhook_secret, notification_on_release_success,
notification_on_release_fail, notification_on_release_aborted,
notification_on_fix_loop_exhausted, notification_on_review_do_not_ship,
notification_on_agent_run_fail, notification_on_budget_blocked,
budget_block_runs_enabled, budget_subscription_providers,
budget_block_at_pct, budget_warn_at_pct, pipeline_model_review,
pipeline_model_fix, pipeline_model_dod, pipeline_model_commit,
dirty_worktree_block_threshold, incremental_review_enabled
```

**POST `/api/settings/test-notification`** — sends a test notification to verify webhook connectivity. Request body: `{ webhook_url: string, webhook_secret?: string }`. Response: `{ ok: boolean, error?: string }`.

---

## Per-project config (not in `settings` table)

These live on the `projects` table row, accessed via `GET/PATCH /api/projects/by-project/[name]/config`:

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `testCommand` | string | `''` | Command run by the test step; auto-detected from `package.json`/`Makefile`/etc. if blank |
| `autoPushEnabled` | boolean | `false` | Enables pipeline chaining (test→review→fix→push) outside of a formal Release run |
| `testCronEnabled` | boolean | `false` | Scheduled test runs |
| `testCronSchedule` | string | `''` | Cron interval for scheduled tests |
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
| Tighten the review→fix loop | `review_fix_max_iterations = 1` (issue is filed after a single failing review; test/commit/push caps are unchanged) |
| Faster polling after a run | Handled automatically by `startFastPolling()` in UI |

### Settings that take effect immediately vs on next run

| Immediate (no restart) | Next job only |
|-----------------------|---------------|
| `review_fix_max_iterations` | `base_prompt`, `commit_style`, `review_verdict_rules` (read at job start) |
| `workspace_path` (next projects scan) | `claude_bin`, `permission_mode` (read at job start) |

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Projects list empty | `workspace_path` not set or wrong path | Go to Settings → set workspace path |
| Claude not found | `claude_bin` path wrong | Verify with `which claude` and update the setting |
| Reviews always pass | `review_verdict_rules` too permissive | Tighten the rules in Settings → Behavior |
| Reviews keep churning until cap, never landing | `review_fix_max_iterations` too high for the project | Lower to `2` or `1`; partial work still ships and a follow-up issue is filed |
| Agents run during the day unexpectedly | `daytime = true` | Set `daytime = false` for night-only |
