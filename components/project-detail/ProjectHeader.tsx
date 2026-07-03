'use client'

import type { ProjectHealth } from '@/hooks/useProjectHealth'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Pill, PillButton } from '@/components/ui/Pill'
import { buttonVariants } from '@/components/ui/Button'
import { ProjectActions, type ProjectActionsProps } from '@/components/project-detail/ProjectActions'

export interface ProjectHeaderProps extends ProjectActionsProps {
  project: ProjectHealth
  boardUrl: string
  releaseTag: string | null
  behindCount: number
  onTogglePause: () => void
  onToggleAutoRelease: () => void
}

// The persistent chrome above every project tab: identity row (logo, title,
// branch/issue/release/board chips, Pause + Auto-release toggles) stacked over
// the action toolbar. Extracted verbatim from ProjectDetailPage to keep that
// page under the file-size cap; the two automation toggles delegate to the
// page-owned handlers via onTogglePause / onToggleAutoRelease.
export function ProjectHeader(props: ProjectHeaderProps) {
  const {
    project,
    projectName: name,
    currentBranch,
    defaultBranch,
    branchCommitsAhead,
    behindCount,
    githubUrl,
    releaseTag,
    boardUrl,
    config,
    onTogglePause,
    onToggleAutoRelease,
  } = props

  return (
    <>
      {/* Header is split into two stacked rows: project identity on top and the
          action toolbar below. This keeps the toolbar left-aligned and stable
          regardless of branch-chip length or active tab. */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <ProjectLogo projectName={project.project} size={24} />
          <h2 className="text-xl font-semibold text-text-primary" data-private>{project.project}</h2>
          {currentBranch && (() => {
            const isDefault = !!defaultBranch && currentBranch === defaultBranch
            // On the default branch the pill is noise — hide entirely.
            // On a feature branch, show just the git-branch icon (+ ahead/behind
            // counts) and put the full branch name in the tooltip. The branch
            // name itself is usually long and redundant with the issue chip
            // that renders next to this.
            if (isDefault) return null
            const ahead = branchCommitsAhead ?? 0
            const behind = behindCount
            return (
              <Pill
                tone="accent"
                size="xs"
                className="rounded-full border-accent/30 bg-accent-light font-mono"
                title={`On feature branch ${currentBranch} — default is ${defaultBranch ?? 'unknown'}`}
                data-private
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                {ahead > 0 && (
                  <span className="text-status-warning tabular-nums" title={`${ahead} commit${ahead !== 1 ? 's' : ''} ahead of origin/${defaultBranch ?? 'default'}`}>
                    ↑{ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="text-status-info tabular-nums" title={`${behind} commit${behind !== 1 ? 's' : ''} behind origin`}>
                    ↓{behind}
                  </span>
                )}
              </Pill>
            )
          })()}
          {currentBranch && githubUrl && (() => {
            const m = currentBranch.match(/^fix\/issue-(\d+)/)
            if (!m) return null
            const issueNumber = m[1]
            return (
              <a
                href={`${githubUrl}/issues/${issueNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({
                  variant: 'info',
                  size: 'sm',
                  className: 'rounded-full py-0.5 font-mono',
                })}
                title={`Open linked GitHub issue #${issueNumber}`}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                  <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
                  <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
                </svg>
                <span>#{issueNumber}</span>
              </a>
            )
          })()}
          {releaseTag && (
            <Pill
              size="xs"
              className="gap-1 rounded-full bg-bg-secondary font-mono tabular-nums"
              title="Latest release"
              data-private
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" className="shrink-0">
                <path d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
              </svg>
              {releaseTag}
            </Pill>
          )}
          {boardUrl && (
            <a
              href={`${boardUrl}?filterQuery=${encodeURIComponent(name)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({
                variant: 'secondary',
                size: 'sm',
                className: 'rounded-full py-0.5 font-normal text-text-secondary hover:border-accent/40 hover:text-accent',
              })}
              title="Open this project on the TamTam GitHub board"
            >
              Board ↗
            </a>
          )}
          <PillButton
            type="button"
            tone="warning"
            active={!!config?.paused}
            inactiveStyle="subtle"
            aria-label={config?.paused ? 'Resume project' : 'Pause project'}
            aria-pressed={!!config?.paused}
            onClick={onTogglePause}
            className={
              config?.paused
                ? 'gap-1 rounded-full border-status-warning/40 bg-status-warning/10 hover:bg-status-warning/20'
                : 'gap-1 rounded-full bg-bg-secondary hover:border-accent/40 hover:bg-bg-secondary hover:text-accent'
            }
            title={config?.paused
              ? 'Project is paused — scheduled agents, agent API runs, and releases are blocked. Manual terminal sessions still work. Click to resume.'
              : 'Pause this project: blocks scheduled agents, agent API runs, and releases without affecting other projects.'}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config?.paused ? 'bg-status-warning' : 'border border-text-tertiary'}`} aria-hidden />
            {config?.paused ? 'Paused' : 'Pause'}
          </PillButton>
          <PillButton
            type="button"
            tone="accent"
            active={!!config?.release_after_run}
            inactiveStyle="subtle"
            aria-pressed={!!config?.release_after_run}
            onClick={onToggleAutoRelease}
            className={
              config?.release_after_run
                ? 'gap-1 rounded-full border-accent/40 hover:bg-accent/20'
                : 'gap-1 rounded-full bg-bg-secondary hover:border-accent/40 hover:bg-bg-secondary hover:text-accent'
            }
            title={config?.release_after_run
              ? 'Auto release is ON — release pipeline triggers after each terminal or agent run finishes. Click to disable.'
              : 'Auto release is OFF — click to auto-trigger the release pipeline after each terminal or agent run.'}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${config?.release_after_run ? 'bg-status-success' : 'border border-text-tertiary'}`} aria-hidden />
            {config?.release_after_run ? 'Auto release ON' : 'Auto release'}
          </PillButton>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <ProjectActions {...props} />
        </div>
      </div>
    </>
  )
}
