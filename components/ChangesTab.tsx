'use client'

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { useRouter } from 'next/navigation'
import { fetchChanges, fetchChangeDiff, pullProject, pushProject, PullDivergedError, checkoutDefaultBranch } from '@/lib/client-api'
import type { ChangeFile, ChangesResponse } from '@/lib/client-api'
import { Button, buttonVariants } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { ErrorState } from '@/components/ErrorState'
import { STATUS_LABEL, STATUS_COLOR, StatBar, OperationError } from '@/components/changes-tab/shared'

interface ChangesTabProps {
  projectName: string
  jobsPaused?: boolean
  /** True while a release pipeline runs — gates the tab's own Push/Pull so a
      manual git action here can't race the pipeline's commit/push (mirrors the
      header ProjectActions gate). */
  isPipelineRunning?: boolean
}

interface DiffEntry {
  expanded: boolean
  content?: string
  loading?: boolean
  error?: string
}

// Memoized so the parent's frequent re-renders (push/pull/switch/refresh
// state changes) don't force a fresh diff split + JSX rebuild for every
// expanded entry. The `diff` string is immutable once loaded so the
// default shallow-equal of React.memo is exactly the right check.
const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <EmptyState
        align="start"
        paddingX="none"
        paddingY="none"
        className="p-3"
        title={<span className="text-xs font-normal italic text-text-secondary">No diff content.</span>}
      />
    )
  }
  const lines = diff.split('\n')
  return (
    <pre className="text-xs font-mono overflow-x-auto m-0 p-0 leading-relaxed">
      {lines.map((line, i) => {
        let cls = 'text-text-primary'
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-text-secondary font-semibold'
        else if (line.startsWith('@@')) cls = 'text-accent bg-accent-light'
        else if (line.startsWith('+')) cls = 'text-status-success bg-status-success/10'
        else if (line.startsWith('-')) cls = 'text-status-error bg-status-error/10'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-text-tertiary'
        return (
          <div key={i} className={`px-3 whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
})

export function ChangesTab({ projectName, jobsPaused = false, isPipelineRunning = false }: ChangesTabProps) {
  const router = useRouter()
  const [data, setData] = useState<ChangesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({})
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [diverged, setDiverged] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial', signal?: AbortSignal) => {
    if (mode === 'refresh') setRefreshing(true)
    setError(null)
    try {
      const res = await fetchChanges(projectName, { signal })
      if (signal?.aborted) return
      setData(res)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Failed to load changes')
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [projectName])

  const doPull = async (strategy: 'ff-only' | 'merge' | 'rebase' = 'ff-only') => {
    setPulling(true)
    setPullError(null)
    setDiverged(false)
    try {
      await pullProject(projectName, strategy)
      await load('refresh')
    } catch (err) {
      if (err instanceof PullDivergedError) {
        setDiverged(true)
      } else {
        setPullError(err instanceof Error ? err.message : 'Pull failed')
      }
    } finally {
      setPulling(false)
    }
  }

  const doSwitchDefault = useCallback(async (opts?: { carryChanges?: boolean }) => {
    setSwitching(true)
    setSwitchError(null)
    try {
      await checkoutDefaultBranch(projectName, opts)
      await load('refresh')
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : 'Failed to switch branch')
    } finally {
      setSwitching(false)
    }
  }, [projectName, load])

  const doPush = async () => {
    if (jobsPaused) {
      setPushError('Jobs are paused globally. Resume jobs to start a push.')
      return
    }
    setPushing(true)
    setPushError(null)
    try {
      const result = await pushProject(projectName)
      router.push(`/project/${projectName}/terminal?job=${result.job_id}`)
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Push failed')
    } finally {
      setPushing(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    load('initial', controller.signal)
    return () => controller.abort()
  }, [load])

  // Auto-switch to the default branch when TamTam detects the current feature
  // branch is merged upstream AND the working copy is clean. Avoids stranding
  // the user on a dead branch (fix/issue-N-...) after a PR is merged.
  const autoSwitchFiredRef = useRef(false)
  useEffect(() => {
    if (!data || autoSwitchFiredRef.current) return
    if (!data.branchMerged) return
    if (data.files.length > 0) return
    if (!data.branch || !data.defaultBranch || data.branch === data.defaultBranch) return
    autoSwitchFiredRef.current = true
    doSwitchDefault()
  }, [data, doSwitchDefault])

  const toggleExpand = async (file: ChangeFile) => {
    const key = file.filename
    const prev = diffs[key]
    if (prev?.expanded) {
      setDiffs((d) => ({ ...d, [key]: { ...prev, expanded: false } }))
      return
    }
    if (prev?.content !== undefined || file.binary) {
      setDiffs((d) => ({ ...d, [key]: { ...(prev ?? {}), expanded: true } }))
      return
    }
    setDiffs((d) => ({ ...d, [key]: { expanded: true, loading: true } }))
    try {
      const res = await fetchChangeDiff(projectName, key)
      setDiffs((d) => ({ ...d, [key]: { expanded: true, content: res.diff } }))
    } catch (err) {
      setDiffs((d) => ({
        ...d,
        [key]: { expanded: true, error: err instanceof Error ? err.message : 'Failed to load diff' },
      }))
    }
  }

  if (loading) {
    return (
      <div className="mt-2">
        <div className="bg-bg-secondary rounded-lg p-4 mb-3 flex items-center gap-4">
          <div className="skeleton h-3.5 w-20" />
          <div className="skeleton h-3.5 w-12" />
          <div className="skeleton h-3.5 w-16" />
        </div>
        <div className="border border-border rounded-lg overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5 border-b border-border last:border-0" style={{ opacity: 1 - i * 0.2 }}>
              <div className="skeleton h-4 w-4 rounded shrink-0" />
              <div className="skeleton h-3.5 flex-1 max-w-xs" />
              <div className="skeleton h-3 w-20 ml-auto" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => load('initial')} />
  }

  if (!data || data.files.length === 0) {
    const onNonDefault = !!(data?.branch && data.defaultBranch && data.branch !== data.defaultBranch)
    const pushBlocked = jobsPaused || isPipelineRunning || pushing
    const pushTitle = jobsPaused
      ? 'Jobs are paused globally. Resume jobs to start a push.'
      : `Push ${data?.ahead ?? 0} commit${data?.ahead === 1 ? '' : 's'} to origin`
    return (
      <EmptyState
        paddingY="xs"
        title={<span className="font-normal text-text-secondary">No uncommitted changes.</span>}
        action={
          <div className="-mt-2">
            {data?.branch && (
              <p className="text-xs text-text-tertiary mt-1">on branch <code className="font-mono">{data.branch}</code></p>
            )}
            {onNonDefault && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="info"
                    onClick={() => doSwitchDefault()}
                    disabled={switching}
                    title={`git checkout ${data!.defaultBranch}`}
                  >
                    {switching ? 'Switching…' : `Switch to ${data!.defaultBranch}`}
                  </Button>
                  {data?.openPrUrl && (
                    <a
                      className={buttonVariants({ variant: 'secondary' })}
                      href={data.openPrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open existing PR: ${data.openPrUrl}`}
                    >
                      View PR ↗
                    </a>
                  )}
                </div>
                {data?.branchMerged && (
                  <p className="text-xs text-text-tertiary">Feature branch is already merged into <code className="font-mono">{data.defaultBranch}</code>.</p>
                )}
                {switchError && <OperationError message={switchError} />}
              </div>
            )}
            {(data?.ahead ?? 0) > 0 && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <p className="text-xs text-status-warning font-medium">
                  ↑ {data!.ahead} commit{data!.ahead !== 1 ? 's' : ''} ahead of origin — not yet pushed
                </p>
                <Button
                  variant="warning"
                  onClick={doPush}
                  disabled={pushBlocked}
                  title={pushTitle}
                >
                  {pushing ? 'Pushing…' : `Push ${data!.ahead} commit${data!.ahead !== 1 ? 's' : ''}`}
                </Button>
                {pushError && <OperationError message={pushError} />}
              </div>
            )}
            {(data?.behind ?? 0) > 0 && !diverged && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <p className="text-xs text-status-warning font-medium">
                  ↓ {data!.behind} commit{data!.behind !== 1 ? 's' : ''} behind origin{data?.branch ? `/${data.branch}` : ''}
                </p>
                <Button
                  variant="warning"
                  onClick={() => doPull('ff-only')}
                  disabled={pulling || isPipelineRunning}
                  title={`git pull --ff-only on ${data?.branch ?? 'branch'}`}
                >
                  {pulling ? 'Pulling…' : 'Pull'}
                </Button>
                {pullError && <OperationError message={pullError} />}
              </div>
            )}
            {diverged && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <p className="text-xs text-status-error font-medium">Branches diverged — choose strategy:</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="info"
                    onClick={() => doPull('rebase')}
                    disabled={pulling || isPipelineRunning}
                    title="git pull --rebase (replay your commits on top of remote)"
                  >
                    {pulling ? 'Working…' : 'Rebase'}
                  </Button>
                  <Button
                    onClick={() => doPull('merge')}
                    disabled={pulling || isPipelineRunning}
                    title="git pull --no-ff (create a merge commit)"
                  >
                    {pulling ? 'Working…' : 'Merge'}
                  </Button>
                  <Button variant="ghost" onClick={() => setDiverged(false)}>
                    ✕
                  </Button>
                </div>
                {pullError && <OperationError message={pullError} />}
              </div>
            )}
          </div>
        }
      />
    )
  }

  const pushBlocked = jobsPaused || isPipelineRunning || pushing
  const pushTitle = jobsPaused
    ? 'Jobs are paused globally. Resume jobs to start a push.'
    : `Push ${data.ahead} commit${data.ahead !== 1 ? 's' : ''} to origin/${data.branch}`
  const showBranchSwitch = !!(data.branch && data.defaultBranch && data.branch !== data.defaultBranch)
  const hasTreeAction = showBranchSwitch || data.ahead > 0 || (data.behind > 0 && !diverged) || diverged

  return (
    <div className="mt-2">
      {data.branchMerged && data.branch && data.defaultBranch && data.branch !== data.defaultBranch && (
        <ErrorCallout
          tone="warning"
          padding="none"
          radius="lg"
          preWrap={false}
          className="mb-3 flex flex-wrap items-start gap-3 border-status-warning/40 p-4"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-status-warning">
              Stranded on a merged branch
            </p>
            <p className="text-xs text-text-secondary mt-1">
              <code className="font-mono">{data.branch}</code> is already merged into{' '}
              <code className="font-mono">{data.defaultBranch}</code>. Move your {data.totalFiles} uncommitted
              change{data.totalFiles !== 1 ? 's' : ''} to <code className="font-mono">{data.defaultBranch}</code>{' '}
              and delete the dead local branch.
            </p>
            {switchError && <OperationError message={switchError} className="mt-1" />}
          </div>
          <Button
            variant="warning"
            className="shrink-0"
            onClick={() => doSwitchDefault({ carryChanges: true })}
            disabled={switching}
            title={`git stash → git checkout ${data.defaultBranch} → git branch -D ${data.branch} → git stash pop`}
          >
            {switching ? 'Moving…' : `Move to ${data.defaultBranch}`}
          </Button>
        </ErrorCallout>
      )}
      {/* Working-tree strip: an info line (branch · files · +/- · ahead/behind)
          over a state-resolved action line. Every git action preserves its
          exact gate — Push/Pull/Switch stay disabled under the same conditions
          (jobsPaused, isPipelineRunning, uncommitted files) so a manual action
          here still cannot race the pipeline. */}
      <div className="mb-3 rounded-lg border border-border bg-bg-secondary">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-text-secondary text-xs uppercase tracking-wider font-medium">Changes</span>
            <span className="text-text-primary text-sm font-medium tabular-nums">{data.totalFiles} file{data.totalFiles !== 1 ? 's' : ''}</span>
          </span>
          <span className="flex items-center gap-2 text-sm font-mono tabular-nums">
            <span className="text-status-success">+{data.totalAdditions}</span>
            <span className="text-status-error">-{data.totalDeletions}</span>
          </span>
          {data.branch && (
            <code className="font-mono text-xs bg-bg-tertiary px-1.5 py-0.5 rounded text-text-primary">{data.branch}</code>
          )}
          {data.ahead > 0 && (
            <span className="text-xs font-medium text-status-warning tabular-nums">↑ {data.ahead} ahead</span>
          )}
          {data.behind > 0 && (
            <span className={`text-xs font-medium tabular-nums ${data.totalFiles > 0 ? 'text-text-tertiary' : 'text-status-warning'}`}>
              ↓ {data.behind} behind origin/{data.branch}
            </span>
          )}
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => load('refresh')}
            disabled={refreshing}
            title="Refresh"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>

        {hasTreeAction && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            {showBranchSwitch && (
              <>
                <Button
                  variant="info"
                  size="sm"
                  onClick={() => doSwitchDefault()}
                  disabled={switching || data.totalFiles > 0}
                  title={data.totalFiles > 0
                    ? 'Commit or stash uncommitted changes before switching'
                    : `git checkout ${data.defaultBranch}`}
                >
                  {switching ? 'Switching…' : `Switch to ${data.defaultBranch}`}
                </Button>
                {data.openPrUrl && (
                  <a
                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    href={data.openPrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open existing PR: ${data.openPrUrl}`}
                  >
                    View PR ↗
                  </a>
                )}
              </>
            )}
            {data.ahead > 0 && (
              <Button
                variant="warning"
                size="sm"
                onClick={doPush}
                disabled={pushBlocked}
                title={pushTitle}
              >
                {pushing ? 'Pushing…' : `Push ${data.ahead} commit${data.ahead !== 1 ? 's' : ''}`}
              </Button>
            )}
            {data.behind > 0 && !diverged && (
              <Button
                variant={data.totalFiles > 0 ? 'secondary' : 'warning'}
                size="sm"
                onClick={() => doPull('ff-only')}
                disabled={pulling || isPipelineRunning || data.totalFiles > 0}
                title={
                  data.totalFiles > 0
                    ? `Commit or stash your ${data.totalFiles} local change${data.totalFiles !== 1 ? 's' : ''} before pulling`
                    : `git pull --ff-only on ${data.branch}`
                }
              >
                {pulling ? 'Pulling…' : 'Pull'}
              </Button>
            )}
            {diverged && (
              <>
                <span className="text-xs text-status-error font-medium">Branches diverged — choose strategy:</span>
                <Button
                  variant="info"
                  size="sm"
                  onClick={() => doPull('rebase')}
                  disabled={pulling || isPipelineRunning}
                  title="git pull --rebase (replay your commits on top of remote)"
                >
                  {pulling ? 'Working…' : 'Rebase'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => doPull('merge')}
                  disabled={pulling || isPipelineRunning}
                  title="git pull --no-ff (create a merge commit)"
                >
                  {pulling ? 'Working…' : 'Merge'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDiverged(false)}
                >
                  ✕
                </Button>
              </>
            )}
          </div>
        )}

        {(switchError || pushError || pullError) && (
          <div className="flex flex-col gap-1 border-t border-border px-4 py-2">
            {switchError && <OperationError message={switchError} />}
            {pushError && <OperationError message={pushError} />}
            {pullError && <OperationError message={pullError} />}
          </div>
        )}
      </div>

      <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
        {data.files.map((file) => {
          const entry = diffs[file.filename]
          const isExpanded = !!entry?.expanded
          return (
            <div key={file.filename} className="border-b border-border last:border-b-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full !justify-start !gap-3 !rounded-none !border-0 !px-3 !py-2 text-left !font-normal !text-text-primary hover:bg-bg-tertiary"
                onClick={() => toggleExpand(file)}
              >
                <span className="text-text-tertiary text-xs w-3">{isExpanded ? '▾' : '▸'}</span>
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold font-mono rounded shrink-0 ${STATUS_COLOR[file.status] || 'text-text-secondary bg-bg-tertiary'}`}
                  title={STATUS_LABEL[file.status] || file.status}
                >
                  {file.status}
                </span>
                <span className="flex-1 text-sm font-mono text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                  {file.filename}
                </span>
                {file.binary ? (
                  <span className="text-xs text-text-tertiary italic">binary</span>
                ) : (
                  <>
                    <span className="text-xs font-mono text-status-success w-12 text-right">+{file.additions}</span>
                    <span className="text-xs font-mono text-status-error w-12 text-right">-{file.deletions}</span>
                    <StatBar additions={file.additions} deletions={file.deletions} />
                  </>
                )}
              </Button>
              {isExpanded && (
                <div className="border-t border-border bg-bg-primary overflow-x-auto">
                  {file.binary ? (
                    <div className="p-3 text-xs text-text-secondary italic">Binary file — diff not shown.</div>
                  ) : entry?.loading ? (
                    <div className="p-3 space-y-1.5">
                      <div className="skeleton h-3.5 w-full rounded" />
                      <div className="skeleton h-3.5 w-11/12 rounded" />
                      <div className="skeleton h-3.5 w-5/6 rounded" />
                      <div className="skeleton h-3.5 w-4/6 rounded" />
                      <div className="skeleton h-3.5 w-3/4 rounded" />
                    </div>
                  ) : entry?.error ? (
                    <OperationError message={entry.error} className="p-3" />
                  ) : entry?.content !== undefined ? (
                    <DiffView diff={entry.content} />
                  ) : null}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
