'use client'

import { useState, useEffect, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchProjectDocs } from '@/lib/client-api'
import type { ProjectDoc } from '@/lib/client-api'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from './ErrorState'

interface DocsTabProps {
  projectName: string
}

function countLines(content: string) {
  return content.split('\n').length
}

export function DocsTab({ projectName }: DocsTabProps) {
  const [docs, setDocs] = useState<ProjectDoc[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  function load() {
    setError(null)
    setLoading(true)
    fetchProjectDocs(projectName)
      .then((res) => {
        setDocs(res.docs)
        setActive((currentActive) => (
          currentActive && res.docs.some((doc) => doc.name === currentActive)
            ? currentActive
            : (res.docs[0]?.name ?? null)
        ))
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load docs'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [projectName])

  // Pre-compute line counts once per docs change instead of scanning every
  // doc's content on every render (sidebar + header). Must run before any
  // conditional early return below so hook order stays stable across the
  // loading → loaded transition (Rules of Hooks).
  const lineCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of docs) m.set(d.name, countLines(d.content))
    return m
  }, [docs])

  if (loading) return (
    <div className="mt-2 flex gap-3">
      <div className="w-52 shrink-0 rounded-lg border border-border bg-bg-secondary p-2">
        <div className="mb-2 flex items-center justify-between border-b border-border px-1 pb-2">
          <div className="skeleton h-3 w-20 rounded" />
          <div className="skeleton h-3 w-12 rounded" />
        </div>
        <div className="flex flex-col gap-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded-md" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      </div>
      <div className="flex-1 rounded-lg border border-border bg-bg-secondary p-4">
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
          <div className="min-w-0 flex-1">
            <div className="skeleton mb-2 h-4 w-32 rounded" />
            <div className="skeleton h-3 w-2/3 rounded" />
          </div>
          <div className="skeleton h-3 w-12 rounded" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-3" style={{ opacity: 1 - i * 0.12, width: `${85 - i * 8}%` }} />
        ))}
      </div>
    </div>
  )
  if (error) return <ErrorState message={error} onRetry={load} />
  if (docs.length === 0) return (
    <EmptyState
      bordered
      align="start"
      paddingY="xs"
      className="mt-2"
      title={<span className="text-text-primary">No docs found</span>}
      action={(
        <p className="text-sm text-text-secondary">
          Add a committed <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-xs">README.md</code> or
          <code className="ml-1 rounded bg-bg-tertiary px-1 py-0.5 font-mono text-xs">docs/*.md</code> file to attach project context here.
        </p>
      )}
    />
  )

  const current = docs.find((d) => d.name === active) ?? docs[0]
  const currentLineCount = lineCounts.get(current.name) ?? 0
  const isMarkdown = /\.mdx?$/i.test(current.name)

  return (
    <div className="mt-2 flex gap-3 min-h-0">
      {docs.length > 1 && (
        <div className="w-52 shrink-0 overflow-hidden rounded-lg border border-border bg-bg-secondary">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs uppercase tracking-wider text-text-tertiary">Project docs</span>
            <span className="text-xs tabular-nums text-text-secondary">{docs.length} files</span>
          </div>
          <div className="flex flex-col gap-1 p-2">
            {docs.map((doc) => (
              <Button
                key={doc.name}
                type="button"
                variant="ghost"
                onClick={() => setActive(doc.name)}
                className={`flex w-full items-center justify-between gap-3 rounded-md border-0 px-2.5 py-2 text-left text-xs ${
                  doc.name === current.name
                    ? 'bg-accent/15 text-accent hover:bg-accent/15 hover:text-accent'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
                title={doc.path}
              >
                <span className="min-w-0 truncate font-mono">{doc.name}</span>
                <span className={`shrink-0 tabular-nums ${doc.name === current.name ? 'text-accent' : 'text-text-tertiary'}`}>
                  {lineCounts.get(doc.name) ?? 0}
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-bg-secondary">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{current.name}</p>
            <p className="mt-1 truncate font-mono text-xs text-text-tertiary">{current.path}</p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-text-secondary">{currentLineCount} lines</span>
        </div>
        {isMarkdown ? (
          <div className="doc-markdown max-h-[70vh] overflow-y-auto p-4">
            <Markdown remarkPlugins={[remarkGfm]}>{current.content}</Markdown>
          </div>
        ) : (
          <pre className="max-h-[70vh] overflow-y-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text-primary">
            {current.content}
          </pre>
        )}
      </div>
    </div>
  )
}
