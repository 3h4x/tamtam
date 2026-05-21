'use client'

import Link from 'next/link'

interface WorkflowRunsEmptyStateProps {
  title: string
  description: string
  meta?: string
  actionLabel?: string
  onAction?: () => void
  actionHref?: string
}

const actionClassName =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary'

function EmptyStateGlyph() {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-bg-tertiary text-text-secondary">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M5 6.25h6M5 8.5h6M5 10.75h3.5" />
      </svg>
    </div>
  )
}

export function WorkflowRunsLoadingState() {
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <div className="skeleton h-6 w-36 rounded" />
          <div className="skeleton h-3 w-40 rounded" />
        </div>
        <div className="ml-auto skeleton h-8 w-44 rounded-md" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="skeleton h-8 w-full rounded-md sm:w-72" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-7 w-16 rounded-md" />
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-bg-secondary">
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto_auto_auto] gap-3 border-b border-border bg-bg-secondary px-3 py-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-3 w-14 rounded" />
          ))}
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto_auto_auto] items-center gap-3 border-b border-border px-3 py-3 last:border-0"
            style={{ opacity: 1 - i * 0.1 }}
          >
            <div className="skeleton h-4 w-40 rounded" />
            <div className="skeleton h-4 w-28 rounded" />
            <div className="skeleton h-4 w-24 rounded" />
            <div className="skeleton h-5 w-20 rounded-full" />
            <div className="skeleton ml-auto h-4 w-12 rounded" />
            <div className="skeleton h-4 w-24 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function WorkflowRunDetailLoadingState() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="skeleton h-4 w-36 rounded" />

      <div className="rounded-md border border-border bg-bg-secondary p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="skeleton h-6 w-52 rounded" />
          <div className="skeleton h-5 w-20 rounded-full" />
          <div className="skeleton h-4 w-32 rounded" />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="skeleton h-3 w-14 rounded" />
              <div className="skeleton h-4 w-24 rounded" />
            </div>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <div className="skeleton h-3 w-12 rounded" />
          <div className="skeleton h-16 rounded-md" />
        </div>
      </div>

      <div className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-3 py-2">
          <div className="skeleton h-4 w-24 rounded" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1.2fr)_auto_auto_auto] items-start gap-3 border-b border-border px-3 py-3 last:border-0"
            style={{ opacity: 1 - i * 0.1 }}
          >
            <div className="space-y-2">
              <div className="skeleton h-4 w-32 rounded" />
              <div className="skeleton h-10 rounded-md" />
            </div>
            <div className="skeleton h-5 w-18 rounded-full" />
            <div className="skeleton h-4 w-8 rounded" />
            <div className="skeleton h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function WorkflowRunsEmptyState({
  title,
  description,
  meta,
  actionLabel,
  onAction,
  actionHref,
}: WorkflowRunsEmptyStateProps) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary px-6 py-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <EmptyStateGlyph />
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <p className="max-w-md text-sm text-text-secondary">{description}</p>
          {meta ? <p className="text-xs font-mono text-text-tertiary">{meta}</p> : null}
        </div>
        {actionLabel && actionHref ? (
          <Link href={actionHref} className={actionClassName}>
            {actionLabel}
          </Link>
        ) : actionLabel && onAction ? (
          <button type="button" className={actionClassName} onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}
