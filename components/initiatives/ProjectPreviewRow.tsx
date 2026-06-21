'use client'

import { useState } from 'react'
import type { InitiativePreviewResponse } from '@/app/api/projects/by-project/[projectName]/initiatives/preview/route'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Spinner } from '@/components/ui/Spinner'

interface ProjectPreviewRowProps {
  projectName: string
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; data: InitiativePreviewResponse }
  | { kind: 'error'; message: string }

const KIND_TONE: Record<string, string> = {
  lint: 'text-status-warning',
  todo: 'text-accent',
  fixme: 'text-status-error',
  test: 'text-status-info',
}

export function ProjectPreviewRow({ projectName }: ProjectPreviewRowProps) {
  const [state, setState] = useState<PreviewState>({ kind: 'idle' })

  function handlePreview() {
    if (state.kind === 'loading') return
    setState({ kind: 'loading' })
    fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/initiatives/preview`)
      .then((r) => (r.ok ? (r.json() as Promise<InitiativePreviewResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => setState({ kind: 'done', data }))
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
  }

  return (
    <div className="border border-border rounded-lg bg-bg-primary overflow-hidden">
      {/* Project header row */}
      <div className="flex items-center gap-3 px-3 py-2.5 bg-bg-secondary border-b border-border">
        <span className="text-sm font-medium text-text-primary flex-1" data-private>
          {projectName}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={handlePreview}
          disabled={state.kind === 'loading'}
        >
          {state.kind === 'loading' ? (
            <>
              <Spinner size="sm" shrink aria-hidden="true" />
              Probing…
            </>
          ) : (
            'Preview mining'
          )}
        </Button>
      </div>

      {/* Results area — only renders after a probe */}
      {state.kind === 'done' && (
        <div className="divide-y divide-border/50">
          {state.data.candidates.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-text-tertiary">No mineable chores found — clean.</p>
          ) : (
            state.data.candidates.map((c) => (
              <div key={c.dedupKey} className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  className={`shrink-0 mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-bg-tertiary ${KIND_TONE[c.kind] ?? 'text-text-secondary'}`}
                >
                  {c.kind}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary leading-snug">{c.title}</p>
                  {c.rationale && (
                    <p className="text-[11px] text-text-tertiary mt-0.5 leading-snug">{c.rationale}</p>
                  )}
                </div>
                <span className="shrink-0 tabular-nums text-[11px] text-text-tertiary font-mono mt-0.5" title="Severity score">
                  {c.score > 0 ? c.score.toFixed(1) : '—'}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {state.kind === 'error' && (
        <ErrorCallout padding="none" radius="md" className="m-3 px-2 py-1.5 text-xs" preWrap={false}>
          Failed to preview: {state.message}
        </ErrorCallout>
      )}
    </div>
  )
}
