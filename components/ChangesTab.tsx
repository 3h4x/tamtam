'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { fetchChanges, fetchChangeDiff, pullProject, pushProject, PullDivergedError, checkoutDefaultBranch } from '@/lib/client-api'
import type { ChangeFile, ChangeStatus, ChangesResponse } from '@/lib/client-api'

const STATUS_LABEL: Record<ChangeStatus, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  T: 'type changed',
}

const STATUS_COLOR: Record<ChangeStatus, string> = {
  M: 'text-status-warning bg-status-warning/15',
  A: 'text-status-success bg-status-success/15',
  D: 'text-status-error bg-status-error/15',
  R: 'text-status-info bg-status-info/15',
  C: 'text-status-info bg-status-info/15',
  U: 'text-status-error bg-status-error/15',
  T: 'text-status-warning bg-status-warning/15',
}

const STAT_BAR_BOXES = 5

interface ChangesTabProps {
  projectName: string
}

interface DiffEntry {
  expanded: boolean
  content?: string
  loading?: boolean
  error?: string
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="p-3 text-xs text-text-secondary italic">No diff content.</div>
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
}

function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  if (total === 0) return null
  const minAdd = additions > 0 ? 1 : 0
  const minDel = deletions > 0 ? 1 : 0
  let addBoxes = Math.round((additions / total) * STAT_BAR_BOXES)
  addBoxes = Math.max(minAdd, Math.min(addBoxes, STAT_BAR_BOXES - minDel))
  const delBoxes = deletions > 0 ? STAT_BAR_BOXES - addBoxes : 0
  const emptyBoxes = STAT_BAR_BOXES - addBoxes - delBoxes
  return (
    <span className="inline-flex gap-0.5 items-center">
      {Array.from({ length: addBoxes }).map((_, i) => (
        <span key={`a${i}`} className="w-1.5 h-1.5 bg-status-success rounded-sm" />
      ))}
      {Array.from({ length: delBoxes }).map((_, i) => (
        <span key={`d${i}`} className="w-1.5 h-1.5 bg-status-error rounded-sm" />
      ))}
      {Array.from({ length: emptyBoxes }).map((_, i) => (
        <span key={`e${i}`} className="w-1.5 h-1.5 bg-border rounded-sm" />
      ))}
    </span>
  )
}

export function ChangesTab({ projectName }: ChangesTabProps) {
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
      // Two-phase merge check: only fetch from remote when the branch looks like
      // it could be merged (no unpushed commits and on a non-default branch).
      // This keeps the initial load fast and avoids a git fetch on every tab open.
      if (res.branch && res.defaultBranch && res.branch !== res.defaultBranch && res.ahead === 0) {
        const checked = await fetchChanges(projectName, { checkMerged: true, signal })
        if (signal?.aborted) return
        setData(checked)
      }
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

  const doSwitchDefault = useCallback(async () => {
    setSwitching(true)
    setSwitchError(null)
    try {
      await checkoutDefaultBranch(projectName)
      await load('refresh')
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : 'Failed to switch branch')
    } finally {
      setSwitching(false)
    }
  }, [projectName, load])

  const doPush = async () => {
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
    return <div className="text-text-secondary text-sm p-4">Loading changes...</div>
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="text-status-error text-sm mb-2">{error}</div>
        <button
          className="px-3 py-1.5 text-sm border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer"
          onClick={() => load('initial')}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!data || data.files.length === 0) {
    const onNonDefault = !!(data?.branch && data.defaultBranch && data.branch !== data.defaultBranch)
    return (
      <div className="p-6 text-center text-text-secondary">
        <p className="text-sm">No uncommitted changes.</p>
        {data?.branch && (
          <p className="text-xs text-text-tertiary mt-1">on branch <code className="font-mono">{data.branch}</code></p>
        )}
        {onNonDefault && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <button
              className="px-4 py-1.5 text-sm border border-status-info/60 bg-status-info/10 text-status-info rounded-md hover:bg-status-info/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              onClick={doSwitchDefault}
              disabled={switching}
              title={`git checkout ${data!.defaultBranch}`}
            >
              {switching ? 'Switching…' : `Switch to ${data!.defaultBranch}`}
            </button>
            {data?.branchMerged && (
              <p className="text-xs text-text-tertiary">Feature branch is already merged into <code className="font-mono">{data.defaultBranch}</code>.</p>
            )}
            {switchError && <p className="text-xs text-status-error">{switchError}</p>}
          </div>
        )}
        {(data?.ahead ?? 0) > 0 && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <p className="text-xs text-status-warning font-medium">
              ↑ {data!.ahead} commit{data!.ahead !== 1 ? 's' : ''} ahead of origin — not yet pushed
            </p>
            <button
              className="px-4 py-1.5 text-sm border border-status-warning/60 bg-status-warning/10 text-status-warning rounded-md hover:bg-status-warning/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              onClick={doPush}
              disabled={pushing}
              title={`Push ${data!.ahead} commit${data!.ahead !== 1 ? 's' : ''} to origin`}
            >
              {pushing ? 'Pushing…' : `Push ${data!.ahead} commit${data!.ahead !== 1 ? 's' : ''}`}
            </button>
            {pushError && <p className="text-xs text-status-error">{pushError}</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-2">
      <div className="bg-bg-secondary rounded-lg p-4 mb-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary text-xs uppercase tracking-wider font-medium">Changes</span>
          <span className="text-text-primary text-sm font-medium">
            {data.totalFiles} file{data.totalFiles !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-status-success font-mono">+{data.totalAdditions}</span>
          <span className="text-status-error font-mono">-{data.totalDeletions}</span>
        </div>
        {data.branch && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-text-secondary text-xs uppercase tracking-wider font-medium">Branch</span>
            <code className="font-mono text-xs bg-bg-tertiary px-1.5 py-0.5 rounded text-text-primary">{data.branch}</code>
            {data.defaultBranch && data.branch !== data.defaultBranch && (
              <button
                className="px-2 py-1 text-xs border border-status-info/60 bg-status-info/10 text-status-info rounded-md hover:bg-status-info/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                onClick={doSwitchDefault}
                disabled={switching || data.totalFiles > 0}
                title={data.totalFiles > 0
                  ? 'Commit or stash uncommitted changes before switching'
                  : `git checkout ${data.defaultBranch}`}
              >
                {switching ? 'Switching…' : `Switch to ${data.defaultBranch}`}
              </button>
            )}
            {switchError && <span className="text-xs text-status-error">{switchError}</span>}
          </div>
        )}
        {data.ahead > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-status-warning">
              ↑ {data.ahead} commit{data.ahead !== 1 ? 's' : ''} ahead
            </span>
            <button
              className="px-2 py-1 text-xs border border-status-warning/60 bg-status-warning/10 text-status-warning rounded-md hover:bg-status-warning/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              onClick={doPush}
              disabled={pushing}
              title={`Push ${data.ahead} commit${data.ahead !== 1 ? 's' : ''} to origin/${data.branch}`}
            >
              {pushing ? 'Pushing…' : 'Push'}
            </button>
          </div>
        )}
        {data.behind > 0 && !diverged && (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${data.totalFiles > 0 ? 'text-text-tertiary' : 'text-status-warning'}`}>
              ↓ {data.behind} commit{data.behind !== 1 ? 's' : ''} behind origin/{data.branch}
            </span>
            <button
              className={`px-2 py-1 text-xs border rounded-md font-medium disabled:cursor-not-allowed ${
                data.totalFiles > 0
                  ? 'border-border bg-bg-secondary text-text-tertiary opacity-50'
                  : 'bg-status-warning/15 border-status-warning/40 text-status-warning hover:bg-status-warning/25 cursor-pointer'
              }`}
              onClick={() => doPull('ff-only')}
              disabled={pulling || data.totalFiles > 0}
              title={
                data.totalFiles > 0
                  ? `Commit or stash your ${data.totalFiles} local change${data.totalFiles !== 1 ? 's' : ''} before pulling`
                  : `git pull --ff-only on ${data.branch}`
              }
            >
              {pulling ? 'Pulling…' : 'Pull'}
            </button>
          </div>
        )}
        {diverged && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-status-error font-medium">Branches diverged — choose strategy:</span>
            <button
              className="px-2 py-1 text-xs bg-status-info/15 border border-status-info/40 text-status-info rounded-md hover:bg-status-info/25 cursor-pointer disabled:opacity-50 font-medium"
              onClick={() => doPull('rebase')}
              disabled={pulling}
              title="git pull --rebase (replay your commits on top of remote)"
            >
              {pulling ? 'Working…' : 'Rebase'}
            </button>
            <button
              className="px-2 py-1 text-xs bg-bg-tertiary border border-border text-text-primary rounded-md hover:bg-bg-secondary cursor-pointer disabled:opacity-50 font-medium"
              onClick={() => doPull('merge')}
              disabled={pulling}
              title="git pull --no-ff (create a merge commit)"
            >
              {pulling ? 'Working…' : 'Merge'}
            </button>
            <button
              className="px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer"
              onClick={() => setDiverged(false)}
            >
              ✕
            </button>
          </div>
        )}
        {pushError && (
          <span className="text-xs text-status-error">{pushError}</span>
        )}
        {pullError && (
          <span className="text-xs text-status-error">{pullError}</span>
        )}
        <button
          className="ml-auto px-2 py-1 text-xs border border-border rounded-md bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer disabled:opacity-60"
          onClick={() => load('refresh')}
          disabled={refreshing}
          title="Refresh"
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="border border-border rounded-lg overflow-hidden bg-bg-secondary">
        {data.files.map((file) => {
          const entry = diffs[file.filename]
          const isExpanded = !!entry?.expanded
          return (
            <div key={file.filename} className="border-b border-border last:border-b-0">
              <button
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-tertiary cursor-pointer"
                onClick={() => toggleExpand(file)}
              >
                <span className="text-text-tertiary text-xs w-3">{isExpanded ? '▾' : '▸'}</span>
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold font-mono rounded shrink-0 ${STATUS_COLOR[file.status as ChangeStatus] || 'text-text-secondary bg-bg-tertiary'}`}
                  title={STATUS_LABEL[file.status as ChangeStatus] || file.status}
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
              </button>
              {isExpanded && (
                <div className="border-t border-border bg-bg-primary overflow-x-auto">
                  {file.binary ? (
                    <div className="p-3 text-xs text-text-secondary italic">Binary file — diff not shown.</div>
                  ) : entry?.loading ? (
                    <div className="p-3 text-xs text-text-secondary">Loading diff...</div>
                  ) : entry?.error ? (
                    <div className="p-3 text-xs text-status-error">{entry.error}</div>
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
