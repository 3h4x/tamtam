'use client'

import type { ProjectConfig, CustomAction } from '@/lib/client-api'
import { getPipelineSteps, type StepToggleContext } from '@/lib/pipeline/pipeline-steps'

export interface ConfigTabProps {
  config: ProjectConfig | null
  configLoading: boolean

  testCommandInput: string
  setTestCommandInput: (v: string) => void
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
  releaseAfterRunInput: boolean
  setReleaseAfterRunInput: (v: boolean) => void
  prWorkflowEnabledInput: boolean
  setPrWorkflowEnabledInput: (v: boolean) => void
  issueAutoBranchInput: boolean
  setIssueAutoBranchInput: (v: boolean) => void
  testsDisabledInput: boolean
  setTestsDisabledInput: (v: boolean) => void
  reviewDisabledInput: boolean
  setReviewDisabledInput: (v: boolean) => void

  editActions: CustomAction[]
  setEditActions: (v: CustomAction[]) => void

  anyDirty: boolean
  anySaving: boolean
  allSaved: boolean
  onSaveAll: () => void
}

export function ConfigTab({
  config,
  configLoading,
  testCommandInput,
  setTestCommandInput,
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
  releaseAfterRunInput,
  setReleaseAfterRunInput,
  prWorkflowEnabledInput,
  setPrWorkflowEnabledInput,
  issueAutoBranchInput,
  setIssueAutoBranchInput,
  testsDisabledInput,
  setTestsDisabledInput,
  reviewDisabledInput,
  setReviewDisabledInput,
  editActions,
  setEditActions,
  anyDirty,
  anySaving,
  allSaved,
  onSaveAll,
}: ConfigTabProps) {
  if (configLoading) {
    return (
      <div className="space-y-4">
        {[
          { h: 'h-32', rows: 2 },
          { h: 'h-48', rows: 3 },
          { h: 'h-64', rows: 4 },
        ].map((s, i) => (
          <div key={i} className={`bg-bg-secondary rounded-lg border border-border p-4 flex flex-col gap-3 ${s.h}`}>
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
    return <div className="text-text-secondary text-sm">Failed to load configuration</div>
  }

  return (
    <div className="space-y-4">

      {/* File config banner */}
      {config.file_config && config.file_config.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-xs text-text-secondary">
          <span className="font-mono text-accent">.tamtam/config.yml</span>
          <span>—</span>
          <span>overrides: {config.file_config.join(', ')}</span>
          {config.file_config_is_default_branch === false && config.current_branch && (
            <>
              <span>·</span>
              <span className="text-amber-400">
                showing <span className="font-mono">{config.file_config_branch}</span> config
                (you are on <span className="font-mono">{config.current_branch}</span>);
                changes take effect after merge
              </span>
            </>
          )}
          <span className="ml-auto text-text-tertiary">saved automatically on change</span>
        </div>
      )}

      {/* Save bar */}
      <div className="flex items-center justify-end gap-3">
        {anyDirty && !anySaving && (
          <span className="text-xs text-text-tertiary">Unsaved changes</span>
        )}
        <button
          className={`px-4 py-2 text-white border-none rounded-lg font-semibold text-sm transition-colors ${
            allSaved    ? 'bg-status-success cursor-default' :
            anyDirty    ? 'bg-accent hover:bg-accent-hover cursor-pointer' :
                          'bg-accent/40 cursor-default'
          } ${anySaving ? 'opacity-50 cursor-wait' : ''}`}
          onClick={onSaveAll}
          disabled={anySaving || !anyDirty}
        >
          {anySaving ? 'Saving…' : allSaved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* Testing */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-text-primary">Testing</h3>
          <p className="text-xs text-text-tertiary">Test command run before every release</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block font-medium text-sm text-text-primary mb-1.5" htmlFor="test-command">
              Test Command
            </label>
            <input
              id="test-command"
              type="text"
              className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors placeholder:text-text-tertiary"
              value={testCommandInput}
              onChange={(e) => setTestCommandInput(e.target.value)}
              placeholder={config.detected_test_command || 'e.g. npm test, pytest, forge test'}
            />
            <p className="text-xs text-text-tertiary mt-1.5">
              Auto-detected: <code className="bg-bg-tertiary px-1 rounded">{config.detected_test_command || 'none'}</code>
              {' · '}
              Effective: <code className="bg-bg-tertiary px-1 rounded text-accent">{config.effective_test_command || 'none'}</code>
            </p>
          </div>

          <div className="pt-3 border-t border-border">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                id="test-cron-enabled"
                type="checkbox"
                className="w-4 h-4 cursor-pointer accent-accent"
                checked={testCronEnabledInput}
                onChange={(e) => setTestCronEnabledInput(e.target.checked)}
              />
              <span className="text-sm font-medium text-text-primary">Run on schedule</span>
            </label>
            {testCronEnabledInput && (
              <div className="mt-2.5 ml-6 flex items-center gap-2">
                <input
                  type="text"
                  className="w-36 px-3 py-1.5 text-sm bg-bg-tertiary border border-border rounded-md text-text-primary font-mono"
                  value={testCronScheduleInput}
                  onChange={(e) => setTestCronScheduleInput(e.target.value)}
                  placeholder="1h"
                />
                <span className="text-xs text-text-tertiary">e.g. <code className="font-mono">30m</code>, <code className="font-mono">6h</code>, <code className="font-mono">1d</code></span>
              </div>
            )}
            {!testCronEnabledInput && (
              <p className="mt-1 ml-6 text-xs text-text-tertiary">Tests only run manually or via release pipeline.</p>
            )}
          </div>
        </div>

      </div>

      {/* "Work on" pipeline */}
      <div className="bg-bg-secondary rounded-lg p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-1">When you click <span className="font-mono">Work on</span></h3>
        <p className="text-xs text-text-tertiary mb-4">
          Each step of the issue-driven pipeline. Toggle what should fire when you click <span className="font-mono">Work on</span> on a GitHub issue.
        </p>
        <div className="space-y-4">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              id="issue-auto-branch"
              type="checkbox"
              className="w-4 h-4 mt-0.5 cursor-pointer accent-accent"
              checked={issueAutoBranchInput}
              onChange={(e) => setIssueAutoBranchInput(e.target.checked)}
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Create feature branch</span>
              <p className="mt-0.5 text-xs text-text-tertiary">
                Provision <code className="font-mono">fix/issue-&lt;n&gt;-&lt;slug&gt;</code> and check it out before Claude starts editing. Turn off to have Claude work on whatever branch is currently checked out.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Release Pipeline */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-text-primary">Release Pipeline</h3>
            <p className="text-xs text-text-tertiary">Click a step to toggle. Fix is gated by review.{prWorkflowEnabledInput ? ' dod always runs in PR Workflow.' : ''}</p>
          </div>
        </div>

        {/* Mode selector */}
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <div className="flex gap-1 p-1 bg-bg-tertiary rounded-lg border border-border w-fit">
            <button
              type="button"
              onClick={() => { setPrWorkflowEnabledInput(false); setAutoPrMergeEnabledInput(false) }}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${!prWorkflowEnabledInput ? 'bg-bg-secondary text-text-primary shadow-sm border border-border' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              Direct Branch
            </button>
            <button
              type="button"
              onClick={() => setPrWorkflowEnabledInput(true)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${prWorkflowEnabledInput ? 'bg-bg-secondary text-text-primary shadow-sm border border-border' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              PR Workflow
            </button>
          </div>
          <p className="text-xs text-text-tertiary mt-2">
            {prWorkflowEnabledInput
              ? 'Changes are pushed to a feature/issue branch and reviewed via pull request. DoD checkboxes from the linked GitHub issue are verified before merge.'
              : 'Changes are committed and pushed directly to the current branch. No pull request is created.'}
          </p>
        </div>

        {/* Clickable pipeline flow strip */}
        <div className="px-5 py-4 border-b border-border">
          {(() => {
            const stepCtx: StepToggleContext = {
              config: {
                effective_test_command: config.effective_test_command,
                tests_disabled: testsDisabledInput,
                review_disabled: reviewDisabledInput,
                auto_commit_enabled: autoCommitEnabledInput,
                auto_push_enabled: autoPushEnabledInput,
                auto_pr_merge_enabled: autoPrMergeEnabledInput,
                pr_workflow_enabled: prWorkflowEnabledInput,
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
            const steps = getPipelineSteps(prWorkflowEnabledInput ? 'pr' : 'direct')
            return (
              <>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {steps.map((step, i) => {
                    const active = step.isActive(stepCtx)
                    const toggleable = !!step.onToggle && !step.mandatory
                    const title = step.description(stepCtx)
                    const baseChip = 'px-2 py-1 text-xs rounded font-mono border transition-colors'
                    const chipClass = active
                      ? 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25'
                      : 'bg-bg-tertiary text-text-tertiary border-border hover:bg-bg-primary hover:text-text-secondary'
                    const cursorClass = toggleable ? 'cursor-pointer' : 'cursor-default'
                    return (
                      <span key={step.id} className="flex items-center gap-1.5">
                        {toggleable ? (
                          <button
                            type="button"
                            title={title}
                            onClick={() => step.onToggle!(stepCtx)}
                            className={`${baseChip} ${chipClass} ${cursorClass}`}
                          >
                            {step.label}
                          </button>
                        ) : (
                          <span
                            title={title}
                            aria-disabled
                            className={`${baseChip} ${chipClass} ${cursorClass} opacity-90`}
                          >
                            {step.mandatory
                              ? null
                              : <span className="mr-1 text-[10px] opacity-60">↻</span>}
                            {step.label}
                          </span>
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

        {/* Trigger cadence */}
        <div className="px-5 py-2">
          <label className="flex items-start gap-3 p-3 rounded-lg hover:bg-bg-tertiary/50 cursor-pointer transition-colors select-none -mx-3">
            <input
              id="release-after-run"
              type="checkbox"
              className="w-4 h-4 accent-accent rounded mt-0.5 shrink-0 cursor-pointer"
              checked={releaseAfterRunInput}
              onChange={(e) => setReleaseAfterRunInput(e.target.checked)}
            />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-text-primary">Trigger pipeline after each agent run</div>
              <div className="text-xs text-text-tertiary">When a terminal or agent run finishes successfully, automatically start the release pipeline.</div>
            </div>
          </label>
        </div>
      </div>

      {/* Custom Actions */}
      <div className="bg-bg-secondary rounded-lg border border-border">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Custom Actions</h3>
            <p className="text-xs text-text-tertiary">Bash commands that appear as buttons on the project page</p>
          </div>
          <button
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer transition-colors"
            onClick={() => setEditActions([...editActions, { name: '', command: '', color: '#2563eb' }])}
          >
            + Add Action
          </button>
        </div>

        <div className="px-5 py-4">
          {editActions.length === 0 ? (
            <p className="text-sm text-text-tertiary text-center py-4">No custom actions yet.</p>
          ) : (
            <div className="space-y-2">
              <div className="grid gap-x-2 px-1 mb-1" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                <span className="text-xs font-medium text-text-tertiary">Label</span>
                <span className="text-xs font-medium text-text-tertiary">Command</span>
                <span className="text-xs font-medium text-text-tertiary">Color</span>
                <span />
              </div>
              {editActions.map((action, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: '9rem 1fr 2.5rem 2rem' }}>
                  <input
                    type="text"
                    className="px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                    value={action.name}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], name: e.target.value }
                      setEditActions(next)
                    }}
                    placeholder="Deploy"
                  />
                  <input
                    type="text"
                    className="px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                    value={action.command}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], command: e.target.value }
                      setEditActions(next)
                    }}
                    placeholder="./deploy.sh"
                  />
                  <input
                    type="color"
                    className="w-10 h-9 p-0.5 bg-bg-primary border border-border rounded-lg cursor-pointer"
                    value={action.color || '#2563eb'}
                    onChange={(e) => {
                      const next = [...editActions]
                      next[i] = { ...next[i], color: e.target.value }
                      setEditActions(next)
                    }}
                    title="Button color"
                  />
                  <button
                    className="flex items-center justify-center h-9 w-8 text-text-tertiary hover:text-status-error hover:bg-status-error/10 rounded-lg cursor-pointer transition-colors"
                    onClick={() => setEditActions(editActions.filter((_, j) => j !== i))}
                    title="Remove"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>

    </div>
  )
}
