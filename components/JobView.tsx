'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { fetchJob, fixFromJob, rerunJob } from '@/lib/client-api'
import type { JobInfo } from '@/lib/client-api'

export function JobView() {
  const params = useParams<{ name: string; jobId: string }>()
  const name = params.name
  const jobId = params.jobId
  const router = useRouter()
  const [job, setJob] = useState<JobInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  useEffect(() => {
    if (!jobId) return

    let active = true
    const poll = async () => {
      try {
        const data = await fetchJob(jobId)
        if (active) {
          if (data.kind === 'run' && data.session_id) {
            router.replace(`/project/${data.project}/experimental/${data.session_id}`)
            return
          }
          setJob(data)
          setError(null)
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load job')
      }
    }

    poll()
    const interval = setInterval(poll, 3000)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [jobId])

  const handleFix = async () => {
    if (!jobId || !name || fixing) return
    setFixing(true)
    try {
      const result = await fixFromJob(jobId)
      router.push(`/project/${name}/jobs/${result.job_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start fix')
      setFixing(false)
    }
  }

  const handleRerunJob = async () => {
    if (!jobId || !name || rerunning) return
    setRerunning(true)
    try {
      const result = await rerunJob(jobId)
      router.push(`/project/${name}/jobs/${result.job_id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rerun job')
      setRerunning(false)
    }
  }

  const elapsed = job
    ? Math.floor(((job.finished_at || Date.now() / 1000) - job.started_at))
    : 0
  const elapsedStr = elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`

  const isDone = job?.status === 'done'
  const hasOutput = !!(job?.log?.trim())

  return (
    <div className="p-6">
      <button className="text-accent hover:underline text-sm mb-4 inline-block" onClick={() => router.push(`/project/${name}`)}>
        &larr; Back to {name}
      </button>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">
          {job?.kind || 'run'} — {name}
        </h2>
        <div className="flex items-center gap-3">
          {job && (
            <>
              <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${job.status === 'running' ? 'bg-status-warning/15 text-status-warning' : job.exit_code === 0 ? 'bg-status-success/15 text-status-success' : 'bg-status-error/15 text-status-error'}`}>
                {job.status === 'running' ? '● running' : job.exit_code === 0 ? '● done' : '● failed'}
              </span>
              <span className="text-text-secondary text-sm">PID {job.pid}</span>
              <span className="text-text-secondary text-sm">{elapsedStr}</span>
              {isDone && job.exit_code !== null && job.exit_code !== 0 && (
                <span className="text-status-error text-sm">exit {job.exit_code}</span>
              )}
            </>
          )}
        </div>
        {isDone && hasOutput && (
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
              onClick={handleRerunJob}
              disabled={rerunning}
            >
              {rerunning ? 'Starting...' : 'Rerun'}
            </button>
            <button
              className="px-3 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover"
              onClick={handleFix}
              disabled={fixing}
            >
              {fixing ? 'Starting...' : 'Fix Issues'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-status-error mb-4">{error}</div>}

      {job?.prompt && (
        <div className="mt-6">
          <h3 className="mb-3 text-text-primary font-semibold">Prompt</h3>
          <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-secondary rounded-lg p-4 overflow-x-auto max-h-[300px] overflow-y-auto border border-border">{job.prompt}</pre>
        </div>
      )}

      <div className="mt-6">
        <h3 className="mb-3 text-text-primary font-semibold">
          Output
          {job?.status === 'running' && <span className="spinner ml-2 inline-block w-3.5 h-3.5" />}
        </h3>
        {hasOutput ? (
          <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-secondary rounded-lg p-4 overflow-x-auto max-h-[600px] overflow-y-auto border border-border">{job!.log}</pre>
        ) : job?.status === 'running' ? (
          <p className="text-text-secondary text-sm">Waiting for output...</p>
        ) : (
          <p className="text-text-secondary text-sm">No log output captured.</p>
        )}
      </div>

      <div className="mt-6">
        <h3 className="mb-3 text-text-primary font-semibold">Details</h3>
        {job && (
          <div className="grid grid-cols-[auto_1fr] gap-2 text-sm">
            <strong className="text-text-secondary">Status:</strong>
            <span className="text-text-primary">{job.status}</span>
            <strong className="text-text-secondary">Exit Code:</strong>
            <span className="text-text-primary">{job.exit_code !== null ? job.exit_code : 'N/A'}</span>
            <strong className="text-text-secondary">Started:</strong>
            <span className="text-text-primary">{new Date(job.started_at * 1000).toLocaleString()}</span>
            {job.finished_at && (
              <>
                <strong className="text-text-secondary">Finished:</strong>
                <span className="text-text-primary">{new Date(job.finished_at * 1000).toLocaleString()}</span>
              </>
            )}
            {job.duration_ms != null && (
              <>
                <strong className="text-text-secondary">Duration:</strong>
                <span className="text-text-primary">{(job.duration_ms / 1000).toFixed(1)}s</span>
              </>
            )}
            {job.input_tokens != null && (
              <>
                <strong className="text-text-secondary">Tokens:</strong>
                <span className="text-text-primary font-mono">
                  {job.input_tokens.toLocaleString()} in / {job.output_tokens?.toLocaleString() ?? 0} out
                  {(job.cache_read_tokens ?? 0) > 0 && ` / ${job.cache_read_tokens!.toLocaleString()} cache read`}
                  {(job.cache_create_tokens ?? 0) > 0 && ` / ${job.cache_create_tokens!.toLocaleString()} cache write`}
                </span>
              </>
            )}
            {job.session_id && (
              <>
                <strong className="text-text-secondary">Session:</strong>
                <span className="text-text-primary font-mono text-xs">{job.session_id}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
