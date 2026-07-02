'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { fetchSettings } from '@/lib/client-api'

type ReindexResult = {
  ok?: boolean
  chunks?: number
  indexedSources?: number
  skippedSources?: number
  error?: string
}

function settingsValue(settingsRes: unknown, key: string): unknown {
  if (!settingsRes || typeof settingsRes !== 'object') return undefined
  const direct = (settingsRes as Record<string, unknown>)[key]
  if (direct !== undefined) return direct
  const nested = (settingsRes as { settings?: unknown }).settings
  if (!nested || typeof nested !== 'object') return undefined
  return (nested as Record<string, unknown>)[key]
}

export function RetrievalReindexPanel({ projectName }: { projectName: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const [recordCount, setRecordCount] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ReindexResult | null>(null)

  async function refreshStatus() {
    try {
      const [settingsRes, statsRes] = await Promise.all([
        fetchSettings(),
        fetch(`/api/projects/${encodeURIComponent(projectName)}/retrieval/stats`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ])
      const retrievalEnabled = settingsValue(settingsRes, 'retrieval_enabled')
      setEnabled(retrievalEnabled === true || retrievalEnabled === 'true')
      if (statsRes && typeof statsRes === 'object') {
        setChunkCount(typeof statsRes.chunks === 'number' ? statsRes.chunks : null)
        setRecordCount(typeof statsRes.records === 'number' ? statsRes.records : null)
      }
    } catch {
      setEnabled(null)
    }
  }

  useEffect(() => {
    refreshStatus()
  }, [projectName])

  async function handleReindex() {
    setRunning(true)
    setResult(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/retrieval/reindex`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      setResult({ ok: res.ok, ...body })
      if (res.ok) await refreshStatus()
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary/50 p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Retrieval (Embeddings)</h3>
          <p className="mt-1 text-xs text-text-tertiary">
            Index this project&apos;s docs, skills, and config into pgvector via local Ollama embeddings. Indexed chunks are injected into agent prompts when relevant.
          </p>
        </div>
        <Button
          variant="solid"
          onClick={handleReindex}
          disabled={running || enabled !== true}
          className="shrink-0"
          title={
            enabled === false
              ? 'Enable retrieval in Settings → General'
              : enabled === null
                ? 'Checking retrieval status…'
                : undefined
          }
        >
          {running ? 'Reindexing…' : 'Reindex now'}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3 text-sm">
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Status</div>
          <div className="mt-1 font-medium text-text-primary">
            {enabled === null ? '…' : enabled ? 'Enabled' : 'Disabled (Settings → General)'}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Indexed records</div>
          <div className="mt-1 font-medium text-text-primary">{recordCount ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-border bg-bg-primary/50 p-3">
          <div className="text-xs uppercase tracking-wide text-text-tertiary">Total chunks</div>
          <div className="mt-1 font-medium text-text-primary">{chunkCount ?? '—'}</div>
        </div>
      </div>
      {result && (result.ok ? (
        <div className="mt-4 rounded-lg border border-status-success/40 bg-status-success/10 p-3 text-sm text-status-success">
          {`Reindex complete — ${result.chunks ?? 0} chunks, ${result.indexedSources ?? 0} indexed, ${result.skippedSources ?? 0} skipped.`}
        </div>
      ) : (
        <ErrorCallout radius="lg" padding="md" className="mt-4 text-sm">
          {`Reindex failed: ${result.error ?? 'unknown error'}`}
        </ErrorCallout>
      ))}
    </div>
  )
}
