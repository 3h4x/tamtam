'use client'

import type { ProjectConfig, CustomAction } from '@/lib/client-api'
import { getPipelineSteps, type StepToggleContext } from '@/lib/pipeline/pipeline-steps'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { ColorInput } from '@/components/ui/ColorInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { Input } from '@/components/ui/Input'
import { Pill, PillButton } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'
import { Textarea } from '@/components/ui/Textarea'

const DEFAULT_ACTION_COLOR = '#2563eb'
const LEGACY_ACTION_COLORS: Record<string, string> = {
  blue: '#2563eb',
  green: '#16a34a',
  red: '#dc2626',
  yellow: '#ca8a04',
  orange: '#ea580c',
  purple: '#9333ea',
  gray: '#6b7280',
  grey: '#6b7280',
}

export function normalizeActionColorForPicker(color?: string): string {
  const value = color?.trim()
  if (!value) return DEFAULT_ACTION_COLOR
  if (/^#[0-9a-f]{6}$/i.test(value)) return value
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase()
  }
  return LEGACY_ACTION_COLORS[value.toLowerCase()] || DEFAULT_ACTION_COLOR
}

export interface ConfigTabProps {
  config: ProjectConfig | null
  configLoading: boolean
  onRetry?: () => void

  testCommandInput: string
  setTestCommandInput: (v: string) => void
  releaseTimeoutMinutesInput: string
  setReleaseTimeoutMinutesInput: (v: string) => void
  testCronEnabledInput: boolean
  setTestCronEnabledInput: (v: boolean) => void
  testCronScheduleInput: string
  setTestCronScheduleInput: (v: string) => void

  autoCommitEnabledInput: boolean
  setAutoCommitEnabledInput: (v: boolean) => void
  autoPushEnabledInput: boolean
  setAutoPushEnabledInput: (v: boolean) => void
  autoPrMergeEnabledInput: boolean
  setAutoPrMergeEnabledInput: (v: boolean) => void
  postMergeWatchMinutesInput: string
  setPostMergeWatchMinutesInput: (v: string) => void
  autoRevertEnabledInput: boolean
  setAutoRevertEnabledInput: (v: boolean) => void
  releaseAfterRunInput: boolean
  setReleaseAfterRunInput: (v: boolean) => void
  issueAutoBranchInput: boolean
  setIssueAutoBranchInput: (v: boolean) => void
  testsDisabledInput: boolean
  setTestsDisabledInput: (v: boolean) => void
  reviewDisabledInput: boolean
  setReviewDisabledInput: (v: boolean) => void
  reviewPromptAddendumInput: string
  setReviewPromptAddendumInput: (v: string) => void
  reviewPrerequisiteCommandInput: string
  setReviewPrerequisiteCommandInput: (v: string) => void
  fixPromptAddendumInput: string
  setFixPromptAddendumInput: (v: string) => void
  commitStyleInput: string
  setCommitStyleInput: (v: string) => void
  websiteInput: string
  setWebsiteInput: (v: string) => void
  qaUrlInput: string
  setQaUrlInput: (v: string) => void
  devServerStartCommandInput: string
  setDevServerStartCommandInput: (v: string) => void
  devServerStopCommandInput: string
  setDevServerStopCommandInput: (v: string) => void
  devServerReadyUrlInput: string
  setDevServerReadyUrlInput: (v: string) => void
  dailySpendCapUsdInput: string
  setDailySpendCapUsdInput: (v: string) => void
  releaseSpendCapUsdInput: string
  setReleaseSpendCapUsdInput: (v: string) => void

  editActions: CustomAction[]
  setEditActions: (v: CustomAction[]) => void

  anyDirty: boolean
  anySaving: boolean
  allSaved: boolean
  onSaveAll: () => void
  onDiscard?: () => void
  onRunSetup?: () => void
}

export function ConfigTab({
  config,
  configLoading,
  onRetry,
  testCommandInput,
  setTestCommandInput,
  releaseTimeoutMinutesInput,
  setReleaseTimeoutMinutesInput,
  testCronEnabledInput,
  setTestCronEnabledInput,
  testCronScheduleInput,
  setTestCronScheduleInput,
  autoCommitEnabledInput,
  setAutoCommitEnabledInput,
  autoPushEnabledInput,
  setAutoPushEnabledInput,
  autoPrMergeEnabledInput,
  setAutoPrMergeEnabledInput,
  postMergeWatchMinutesInput,
  setPostMergeWatchMinutesInput,
  autoRevertEnabledInput,
  setAutoRevertEnabledInput,
  releaseAfterRunInput,
  setReleaseAfterRunInput,
  issueAutoBranchInput,
  setIssueAutoBranchInput,
  testsDisabledInput,
  setTestsDisabledInput,
  reviewDisabledInput,
  setReviewDisabledInput,
  reviewPromptAddendumInput,
  setReviewPromptAddendumInput,
  reviewPrerequisiteCommandInput,
  setReviewPrerequisiteCommandInput,
  fixPromptAddendumInput,
  setFixPromptAddendumInput,
  commitStyleInput,
  setCommitStyleInput,
  websiteInput,
  setWebsiteInput,
  qaUrlInput,
  setQaUrlInput,
  devServerStartCommandInput,
  setDevServerStartCommandInput,
  devServerStopCommandInput,
  setDevServerStopCommandInput,
  devServerReadyUrlInput,
  setDevServerReadyUrlInput,
  dailySpendCapUsdInput,
  setDailySpendCapUsdInput,
  releaseSpendCapUsdInput,
  setReleaseSpendCapUsdInput,
  editActions,
  setEditActions,
  anyDirty,
  anySaving,
  allSaved,
  onSaveAll,
  onDiscard,
  onRunSetup = () => {},
}: ConfigTabProps) {
  const postMergeWatchMinutes = Number.parseInt(postMergeWatchMinutesInput, 10) || 0
  const last24hSpend = config?.last_24h_spend_usd ?? 0
  if (configLoading) {
    return (
      <div className="space-y-3">
        {[
          { h: 'h-28', rows: 2 },
          { h: 'h-40', rows: 3 },
          { h: 'h-56', rows: 4 },
        ].map((s, i) => (
          <div key={i} className={`bg-bg-secondary rounded-md border border-border p-3 flex flex-col gap-2.5 ${s.h}`}>
            <div className="skeleton h-3.5 w-1/4 rounded" />
            {Array.from({ length: s.rows }).map((_, j) => (
              <div key={j} className="skeleton h-4 rounded" style={{ width: `${90 - j * 10}%` }} />
            ))}
          </div>
        ))}
      </div>
    )
  }

  if (!config) {
    return <ErrorState message="Failed to load configuration" onRetry={onRetry} />
  }

  return (
    <div className="space-y-3">

      {/* File config banner + save bar (single row when both present) */}
      <div className="flex items-center gap-2 flex-wrap">
        {config.file_config && config.file_config.length > 0 && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-tertiary border border-border text-xs text-text-secondary flex-1 min-w-0">
            <span className="font-mono text-accent shrink-0">.tamtam/config.yml</span>
            <span className="text-text-tertiary">overrides: {config.file_config.join(', ')}</span>
            {config.file_config_is_default_branch === false && config.current_branch && (
              <span className="text-status-warning truncate">
                · showing <span className="font-mono">{config.file_config_branch}</span>{' '}
                (on <span className="font-mono">{config.current_branch}</span>) — effective after merge
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <Button
            variant="secondary"
            size="sm"
            onClick={onRunSetup}
          >
            Run setup wizard
          </Button>
        </div>
      </div>

      {/* Section jump-nav — the form is long; this lets you jump to a section
          instead of scrolling the whole ~2800px page. Anchors carry scroll-mt
          so the sticky app header doesn't cover the target heading. */}
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-bg-secondary px-2 py-1.5">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">jump</span>
        {([
          ['cfg-budget', 'Budget'],
          ['cfg-website', 'Targets'],
          ['cfg-dev-server', 'Dev server'],
          ['cfg-testing', 'Testing'],
          ['cfg-work-on-issue', 'Issues'],
          ['cfg-release-pipeline', 'Pipeline'],
          ['cfg-custom-actions', 'Actions'],
        ] as [string, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="rounded px-2 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            {label}
          </button>
        ))}
      </div>

      {/* Spend budgets */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline gap-3">
          <h3 id="cfg-budget" className="scroll-mt-20 text-sm font-semibold text-text-primary">Budget</h3>
          <p className="text-xs text-text-tertiary">Per-project spend caps for unattended agent and release automation</p>
          <span className="ml-auto text-xs text-text-secondary tabular-nums">
            Last 24h: ${last24hSpend.toFixed(2)}
          </span>
        </div>
        <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="daily-spend-cap-usd">
              Daily spend cap (USD)
            </label>
            <Input
              inputSize="compact"
              id="daily-spend-cap-usd"
              type="text"
              inputMode="decimal"
              value={dailySpendCapUsdInput}
              onChange={(e) => setDailySpendCapUsdInput(e.target.value)}
              placeholder="No cap"
            />
            <p className="text-xs text-text-tertiary mt-1">Blocks new agent runs and Release starts after rolling 24h project spend reaches this amount. Empty = no cap.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="release-spend-cap-usd">
              Per-release cap (USD)
            </label>
            <Input
              inputSize="compact"
              id="release-spend-cap-usd"
              type="text"
              inputMode="decimal"
              value={releaseSpendCapUsdInput}
              onChange={(e) => setReleaseSpendCapUsdInput(e.target.value)}
              placeholder="No cap"
            />
            <p className="text-xs text-text-tertiary mt-1">Stops an active Release at the next phase boundary once its child jobs reach this amount.</p>
          </div>
        </div>
      </div>

      {/* Website + QA target */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline gap-3">
          <h3 id="cfg-website" className="scroll-mt-20 text-sm font-semibold text-text-primary">Website</h3>
          <p className="text-xs text-text-tertiary">Public/production URL — used by the QA agent when no explicit QA target is set</p>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="project-website">
              Website
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="project-website"
              type="text"
              value={websiteInput}
              onChange={(e) => setWebsiteInput(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="project-qa-url">
              QA URL <span className="text-text-tertiary font-normal">(overrides Website for QA)</span>
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="project-qa-url"
              type="text"
              value={qaUrlInput}
              onChange={(e) => setQaUrlInput(e.target.value)}
              placeholder="http://localhost:1338"
            />
            <p className="text-xs text-text-tertiary mt-1">
              Explicit target for the QA agent. Use a local URL (e.g. a docker-compose stack started by the agent's prerequisite) when you don't want to QA the live site.
            </p>
          </div>
        </div>
      </div>

      {/* Dev server lifecycle */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline gap-3">
          <h3 id="cfg-dev-server" className="scroll-mt-20 text-sm font-semibold text-text-primary">Dev Server</h3>
          <p className="text-xs text-text-tertiary">Local app lifecycle around agent runs</p>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="dev-server-start-command">
              Start command
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="dev-server-start-command"
              type="text"
              value={devServerStartCommandInput}
              onChange={(e) => setDevServerStartCommandInput(e.target.value)}
              placeholder="pnpm dev --port 3000"
            />
            <p className="text-xs text-text-tertiary mt-1">Run from the project root before an agent starts. Empty = do not manage a dev server.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="dev-server-ready-url">
              Ready URL
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="dev-server-ready-url"
              type="text"
              value={devServerReadyUrlInput}
              onChange={(e) => setDevServerReadyUrlInput(e.target.value)}
              placeholder="http://localhost:3000"
            />
            <p className="text-xs text-text-tertiary mt-1">Polled until it returns a non-5xx response. Use http(s) URLs only.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="dev-server-stop-command">
              Stop command
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="dev-server-stop-command"
              type="text"
              value={devServerStopCommandInput}
              onChange={(e) => setDevServerStopCommandInput(e.target.value)}
              placeholder="pnpm dev:stop"
            />
            <p className="text-xs text-text-tertiary mt-1">Optional cleanup command. Empty = TamTam stops the process group it started.</p>
          </div>
        </div>
      </div>

      {/* Testing */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline gap-3">
          <h3 id="cfg-testing" className="scroll-mt-20 text-sm font-semibold text-text-primary">Testing</h3>
          <p className="text-xs text-text-tertiary">Test command run before every release</p>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="test-command">
              Test Command
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="test-command"
              type="text"
              value={testCommandInput}
              onChange={(e) => setTestCommandInput(e.target.value)}
              placeholder={config.detected_test_command || 'e.g. npm test, pytest, forge test'}
            />
            <p className="text-xs text-text-tertiary mt-1">
              Detected: <code className="bg-bg-tertiary px-1 rounded">{config.detected_test_command || 'none'}</code>
              {' · '}
              Effective: <code className="bg-bg-tertiary px-1 rounded text-accent">{config.effective_test_command || 'none'}</code>
            </p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="release-timeout-minutes">
              Release timeout (minutes)
              <span aria-hidden="true" className="ml-2 text-text-tertiary font-normal">.tamtam/config.yml</span>
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="release-timeout-minutes"
              type="text"
              inputMode="numeric"
              value={releaseTimeoutMinutesInput}
              onChange={(e) => setReleaseTimeoutMinutesInput(e.target.value)}
              placeholder="60"
            />
            <p className="text-xs text-text-tertiary mt-1">
              Team-wide wall-clock budget for Release runs. Empty = use the global pipeline setting.
            </p>
          </div>

          <div className="pt-2 border-t border-border">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                variant="native"
                id="test-cron-enabled"
                checked={testCronEnabledInput}
                onChange={(e) => setTestCronEnabledInput(e.target.checked)}
              />
              <span className="text-sm font-medium text-text-primary">Run on schedule</span>
              {testCronEnabledInput && (
                <Input
                  appearance="muted"
                  inputSize="compact"
                  paddingX="compact"
                  fullWidth={false}
                  type="text"
                  aria-label="Schedule interval"
                  className="ml-2 w-28 text-xs"
                  value={testCronScheduleInput}
                  onChange={(e) => setTestCronScheduleInput(e.target.value)}
                  placeholder="1h"
                />
              )}
              <span className="text-xs text-text-tertiary ml-1">
                {testCronEnabledInput ? <>e.g. <code className="font-mono">30m</code>, <code className="font-mono">6h</code>, <code className="font-mono">1d</code></> : 'Manual or pipeline-only.'}
              </span>
            </label>
          </div>
        </div>

      </div>

      {/* "Work on" issue */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline gap-3">
          <h3 id="cfg-work-on-issue" className="scroll-mt-20 text-sm font-semibold text-text-primary">Work on issue</h3>
          <p className="text-xs text-text-tertiary">What fires when you click <span className="font-mono">Work on</span> on a GitHub issue</p>
        </div>
        <div className="px-4 py-3">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <Checkbox
              variant="native"
              className="mt-0.5"
              id="issue-auto-branch"
              checked={issueAutoBranchInput}
              onChange={(e) => setIssueAutoBranchInput(e.target.checked)}
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Create feature branch</span>
              <p className="text-xs text-text-tertiary">
                Provision <code className="font-mono">fix/issue-&lt;n&gt;-&lt;slug&gt;</code> before Claude edits. Off = work on current branch.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Release Pipeline */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-baseline justify-between gap-3 flex-wrap">
          <h3 id="cfg-release-pipeline" className="scroll-mt-20 text-sm font-semibold text-text-primary">Release Pipeline</h3>
          <p className="text-xs text-text-tertiary">Click a step to toggle. `fix` runs automatically as part of review. On non-default branches, push opens a PR, then PR wait/merge and DoD handling complete the release automatically.</p>
        </div>

        {/* Clickable pipeline flow strip */}
        <div className="px-4 py-3 border-b border-border">
          {(() => {
            const stepCtx: StepToggleContext = {
              config: {
                effective_test_command: config.effective_test_command,
                tests_disabled: testsDisabledInput,
                review_disabled: reviewDisabledInput,
                auto_commit_enabled: autoCommitEnabledInput,
                auto_push_enabled: autoPushEnabledInput,
                auto_pr_merge_enabled: autoPrMergeEnabledInput,
                post_merge_watch_minutes: postMergeWatchMinutes,
                auto_revert_enabled: autoRevertEnabledInput,
              },
              setters: {
                setAutoCommit: setAutoCommitEnabledInput,
                setAutoPush: setAutoPushEnabledInput,
                setAutoMerge: setAutoPrMergeEnabledInput,
                setTestsDisabled: setTestsDisabledInput,
                setReviewDisabled: setReviewDisabledInput,
              },
              focusElement: (id: string) => {
                const el = document.getElementById(id) as HTMLElement | null
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  el.focus()
                }
              },
            }
            const steps = getPipelineSteps()
            return (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {steps.map((step, i) => {
                    const active = step.isActive(stepCtx)
                    const toggleable = !!step.onToggle && !step.mandatory
                    const title = step.description(stepCtx)
                    const chipClass = active
                      ? 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25'
                      : 'bg-bg-tertiary text-text-tertiary border-border hover:bg-bg-primary hover:text-text-secondary'
                    const cursorClass = toggleable ? 'cursor-pointer' : 'cursor-default'
                    return (
                      <span key={step.id} className="flex items-center gap-1.5">
                        {toggleable ? (
                          <PillButton
                            type="button"
                            title={title}
                            onClick={() => step.onToggle!(stepCtx)}
                            active={active}
                            inactiveStyle="subtle"
                            className={`py-1 font-mono ${chipClass} ${cursorClass}`}
                          >
                            {step.label}
                          </PillButton>
                        ) : (
                          <Pill
                            title={title}
                            aria-disabled
                            active={active}
                            inactiveStyle="subtle"
                            className={`py-1 font-mono ${chipClass} ${cursorClass} opacity-90`}
                          >
                            {step.mandatory
                              ? null
                              : <span className="mr-1 text-[10px] opacity-60">↻</span>}
                            {step.label}
                          </Pill>
                        )}
                        {i < steps.length - 1 && <span className="text-text-tertiary text-xs">→</span>}
                      </span>
                    )
                  })}
                </div>
                {/* Inline per-step descriptions */}
                <ul className="mt-3 space-y-1">
                  {steps.map((step) => {
                    const active = step.isActive(stepCtx)
                    return (
                      <li key={step.id} className="flex items-start gap-2 text-xs text-text-tertiary">
                        <span className={`font-mono shrink-0 w-14 ${active ? 'text-accent' : 'text-text-tertiary'}`}>{step.label}</span>
                        <span className="flex-1">{step.description(stepCtx)}</span>
                      </li>
                    )
                  })}
                </ul>
              </>
            )
          })()}
        </div>

        {/* Per-project review/fix prompt addenda */}
        <div className="px-4 py-3 border-b border-border space-y-3">
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="review-prompt-addendum">
              Review prompt addendum
            </label>
            <Textarea
              id="review-prompt-addendum"
              inputSize="compact"
              resize="both"
              rows={3}
              value={reviewPromptAddendumInput}
              onChange={(e) => setReviewPromptAddendumInput(e.target.value)}
              placeholder="e.g. Treat console.log as a non-blocker for this CLI tool."
            />
            <p className="text-xs text-text-tertiary mt-1">Appended to the standard review prompt. Empty = use defaults.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="review-prerequisite-command">
              Review prerequisite command
            </label>
            <Input
              inputSize="compact"
              className="placeholder:text-text-tertiary"
              id="review-prerequisite-command"
              value={reviewPrerequisiteCommandInput}
              onChange={(e) => setReviewPrerequisiteCommandInput(e.target.value)}
              placeholder="e.g. pnpm db:types"
            />
            <p className="text-xs text-text-tertiary mt-1">Runs before each review and adds its output to the review prompt. Empty = no pre-step.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="fix-prompt-addendum">
              Fix prompt addendum
            </label>
            <Textarea
              id="fix-prompt-addendum"
              inputSize="compact"
              resize="both"
              rows={3}
              value={fixPromptAddendumInput}
              onChange={(e) => setFixPromptAddendumInput(e.target.value)}
              placeholder="e.g. Prefer minimal diffs; do not refactor unrelated code."
            />
            <p className="text-xs text-text-tertiary mt-1">Appended to the standard fix prompt. Empty = use defaults.</p>
          </div>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="commit-style">
              Commit message style
              <span aria-hidden="true" className="ml-2 text-text-tertiary font-normal">.tamtam/config.yml</span>
            </label>
            <Textarea
              id="commit-style"
              inputSize="compact"
              resize="both"
              rows={4}
              value={commitStyleInput}
              onChange={(e) => setCommitStyleInput(e.target.value)}
              placeholder={'e.g. Conventional commits, imperative mood, subject under 72 chars, no trailing period.\nFormat: <type>(<scope>): <description>.'}
            />
            <p className="text-xs text-text-tertiary mt-1">Project-specific style guide for auto-generated commit messages. Committed to <span className="font-mono">.tamtam/config.yml</span>; falls back to the global setting when empty.</p>
          </div>
        </div>

        {/* Post-merge soak (wait for default-branch CI on the merge commit). */}
        <div className="px-4 py-3 border-t border-border space-y-3">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <Checkbox
              variant="native"
              id="post-merge-watch-enabled"
              className="mt-0.5"
              checked={postMergeWatchMinutes > 0}
              onChange={(e) => setPostMergeWatchMinutesInput(e.target.checked ? '1' : '0')}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-text-primary">Wait for CI on default branch after merge</div>
              <div className="text-xs text-text-tertiary">
                After PR merge, poll the default branch&apos;s CI on the merge commit until it terminates. On all pass: release unlocks the project. On any fail: TamTam <strong>pauses the project</strong> (no new agent runs accepted until you resume from Settings) and opens a revert PR.
              </div>
            </div>
          </label>
          <div>
            <label className="block font-medium text-xs text-text-secondary mb-1" htmlFor="post-merge-watch-minutes">
              Watch minutes
            </label>
            <Input
              id="post-merge-watch-minutes"
              inputSize="compact"
              fontFamily="sans"
              paddingX="compact"
              className="max-w-28"
              type="number"
              min="0"
              step="1"
              value={postMergeWatchMinutesInput}
              onChange={(e) => setPostMergeWatchMinutesInput(e.target.value)}
            />
            <p className="text-xs text-text-tertiary mt-1">0 disables the watcher. Positive integers keep the release locked until default-branch CI on the merge commit finishes.</p>
          </div>
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <Checkbox
              variant="native"
              id="auto-revert-enabled"
              className="mt-0.5"
              checked={autoRevertEnabledInput}
              onChange={(e) => setAutoRevertEnabledInput(e.target.checked)}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-text-primary">Auto-merge revert PR</div>
              <div className="text-xs text-text-tertiary">When the watcher opens a revert PR, also enable squash auto-merge. Off = the revert PR stays open for human review.</div>
            </div>
          </label>
        </div>

        {/* Trigger cadence — a distinct concern from post-merge soak, so it
            gets its own section rather than being nested under it. */}
        <div className="px-4 py-3 border-t border-border">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <Checkbox
              variant="native"
              id="release-after-run"
              className="mt-0.5"
              checked={releaseAfterRunInput}
              onChange={(e) => setReleaseAfterRunInput(e.target.checked)}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-text-primary">Trigger pipeline after each agent run</div>
              <div className="text-xs text-text-tertiary">Auto-start release when a terminal or agent run finishes successfully.</div>
            </div>
          </label>
        </div>
      </div>

      {/* Custom Actions */}
      <div className="bg-bg-secondary rounded-md border border-border">
        <div className="px-4 py-2 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h3 id="cfg-custom-actions" className="scroll-mt-20 text-sm font-semibold text-text-primary">Custom Actions</h3>
            <p className="text-xs text-text-tertiary">Bash commands shown as buttons on the project page</p>
          </div>
          <Button
            type="button"
            variant="solid"
            size="sm"
            className="px-2.5"
            onClick={() => setEditActions([...editActions, { name: '', command: '', color: DEFAULT_ACTION_COLOR }])}
          >
            + Add Action
          </Button>
        </div>

        <div className="px-4 py-3">
          {editActions.length === 0 ? (
            <EmptyState paddingY="xs" title="No custom actions yet" />
          ) : (
            <div className="space-y-1.5">
              <div className="grid gap-x-2 px-1" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                <span className="text-xs font-medium text-text-tertiary">Label</span>
                <span className="text-xs font-medium text-text-tertiary">Command</span>
                <span className="text-xs font-medium text-text-tertiary">Color</span>
                <span />
              </div>
              {editActions.map((action, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                  <Input
                    inputSize="compact"
                    fontFamily="sans"
                    paddingX="compact"
                    type="text"
                    aria-label={`Action ${i + 1} label`}
                    value={action.name}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], name: e.target.value }
                      setEditActions(next)
                    }}
                    placeholder="Deploy"
                  />
                  <Input
                    inputSize="compact"
                    paddingX="compact"
                    type="text"
                    aria-label={`Action ${i + 1} command`}
                    value={action.command}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], command: e.target.value }
                      setEditActions(next)
                    }}
                    placeholder="./deploy.sh"
                  />
                  <ColorInput
                    value={normalizeActionColorForPicker(action.color)}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], color: e.target.value }
                      setEditActions(next)
                    }}
                    title="Button color"
                  />
                  <Button
                    type="button"
                    variant="danger"
                    size="icon-sm"
                    onClick={() => setEditActions(editActions.filter((_, j) => j !== i))}
                    title="Remove"
                  >
                    &times;
                  </Button>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>

      {/* Sticky save bar — always reachable on this long form (Save lived only
          at the top before). Discard/reset is deferred to the config
          form-model refactor. */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 rounded-md border border-border bg-bg-secondary px-4 py-2.5">
        {allSaved ? (
          <span className="text-xs text-status-success">Saved</span>
        ) : anyDirty ? (
          <span className="text-xs text-text-secondary">Unsaved changes</span>
        ) : (
          <span className="text-xs text-text-tertiary">All changes saved</span>
        )}
        <div className="flex-1" />
        {onDiscard && anyDirty && !anySaving && (
          <Button
            variant="ghost"
            size="sm"
            className="text-text-tertiary hover:text-text-primary"
            onClick={onDiscard}
            title="Reset all fields to the last saved values"
          >
            Discard
          </Button>
        )}
        <Button
          variant={allSaved ? 'success-solid' : 'solid'}
          disabledCursor={anySaving ? 'wait' : 'default'}
          className={`px-4 py-1.5 border-none rounded-md font-semibold text-white ${
            !allSaved && !anyDirty ? 'bg-accent/40 hover:bg-accent/40' : ''
          } ${anySaving ? 'opacity-70 cursor-wait disabled:cursor-wait disabled:opacity-70' : 'disabled:opacity-100'}`}
          onClick={onSaveAll}
          disabled={anySaving || !anyDirty}
        >
          {anySaving && <Spinner color="white" shrink />}
          {anySaving ? 'Saving…' : allSaved ? 'Saved!' : 'Save'}
        </Button>
      </div>

    </div>
  )
}
