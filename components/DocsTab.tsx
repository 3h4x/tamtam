'use client'

import { useState, useEffect } from 'react'
import { fetchProjectDocs } from '@/lib/client-api'
import type { ProjectDoc } from '@/lib/client-api'

interface DocsTabProps {
  projectName: string
}

export function DocsTab({ projectName }: DocsTabProps) {
  const [docs, setDocs] = useState<ProjectDoc[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchProjectDocs(projectName)
      .then((res) => {
        setDocs(res.docs)
        setActive(res.docs[0]?.name ?? null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load docs'))
      .finally(() => setLoading(false))
  }, [projectName])

  if (loading) return (
    <div className="mt-2 flex gap-3">
      <div className="w-44 shrink-0 flex flex-col gap-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-7 rounded-md" style={{ opacity: 1 - i * 0.2 }} />
        ))}
      </div>
      <div className="flex-1 border border-border rounded-lg p-4 flex flex-col gap-2">
        <div className="skeleton h-4 w-1/3 mb-2" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-3" style={{ opacity: 1 - i * 0.12, width: `${85 - i * 8}%` }} />
        ))}
      </div>
    </div>
  )
  if (error) return <div className="text-status-error text-sm p-4">{error}</div>
  if (docs.length === 0) return (
    <div className="p-6 text-center text-text-secondary text-sm">
      No docs found. Add a <code className="font-mono text-xs">README.md</code> or <code className="font-mono text-xs">docs/*.md</code> files.
    </div>
  )

  const current = docs.find((d) => d.name === active) ?? docs[0]

  return (
    <div className="mt-2 flex gap-3 min-h-0">
      {docs.length > 1 && (
        <div className="w-44 shrink-0 flex flex-col gap-0.5">
          {docs.map((doc) => (
            <button
              key={doc.name}
              onClick={() => setActive(doc.name)}
              className={`text-left px-2.5 py-1.5 rounded-md text-xs font-mono truncate cursor-pointer transition-colors ${
                doc.name === current.name
                  ? 'bg-accent/15 text-accent font-semibold'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'
              }`}
              title={doc.path}
            >
              {doc.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-mono text-text-tertiary">{current.path}</span>
          <span className="text-xs text-text-tertiary">·</span>
          <span className="text-xs text-text-tertiary">{current.content.split('\n').length} lines</span>
        </div>
        <pre className="bg-bg-secondary border border-border rounded-lg p-4 text-xs text-text-primary font-mono whitespace-pre-wrap overflow-y-auto max-h-[70vh] leading-relaxed">
          {current.content}
        </pre>
      </div>
    </div>
  )
}
