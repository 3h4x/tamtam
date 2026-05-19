'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Button, buttonVariants, type ButtonVariant } from '@/components/ui/Button'

type StatTone = 'default' | 'accent' | 'success' | 'warning' | 'muted'

interface AgentStateStat {
  label: string
  value: ReactNode
  tone?: StatTone
  mono?: boolean
}

interface StateAction {
  label: string
  variant?: ButtonVariant
  href?: string
  onClick?: () => void
}

interface AgentsEmptyStateProps {
  title: string
  description: string
  stats: AgentStateStat[]
  meta?: string
  primaryAction?: StateAction
  secondaryAction?: StateAction
  framed?: boolean
}

const toneClass: Record<StatTone, string> = {
  default: 'text-text-primary',
  accent: 'text-accent',
  success: 'text-status-success',
  warning: 'text-status-warning',
  muted: 'text-text-tertiary',
}

function AgentGlyph() {
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
        <path d="M4 4.25h5.5a2 2 0 0 1 1.42.59l1.24 1.24a2 2 0 0 1 .59 1.41v3.26a1.75 1.75 0 0 1-1.75 1.75H5A1.75 1.75 0 0 1 3.25 10.75V5A.75.75 0 0 1 4 4.25Z" />
        <path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" />
      </svg>
    </div>
  )
}

function StateActionButton({ action }: { action: StateAction }) {
  if (action.href) {
    return (
      <Link href={action.href} className={buttonVariants({ variant: action.variant ?? 'secondary', size: 'sm' })}>
        {action.label}
      </Link>
    )
  }

  if (action.onClick) {
    return (
      <Button type="button" size="sm" variant={action.variant ?? 'secondary'} onClick={action.onClick}>
        {action.label}
      </Button>
    )
  }

  return null
}

export function AgentsLoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading agents">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-md border border-border bg-bg-secondary px-3 py-2">
            <div className="skeleton h-3 w-[4.5rem] rounded" />
            <div className="mt-2 skeleton h-5 w-18 rounded" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-bg-primary">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b border-border bg-bg-secondary px-3 py-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-3 w-16 rounded" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-3 last:border-0"
            style={{ opacity: 1 - index * 0.08 }}
          >
            <div className="skeleton h-5 w-18 rounded-full" />
            <div className="space-y-1.5">
              <div className="skeleton h-4 w-28 rounded" />
              <div className="skeleton h-3 w-16 rounded" />
            </div>
            <div className="space-y-1.5">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-3 w-18 rounded" />
            </div>
            <div className="skeleton h-4 w-20 rounded" />
            <div className="skeleton h-4 w-24 rounded" />
            <div className="flex justify-end gap-2">
              <div className="skeleton h-7 w-12 rounded-md" />
              <div className="skeleton h-7 w-14 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AgentsEmptyState({
  title,
  description,
  stats,
  meta,
  primaryAction,
  secondaryAction,
  framed = true,
}: AgentsEmptyStateProps) {
  return (
    <div className={framed ? 'rounded-lg border border-border bg-bg-secondary px-4 py-5' : 'px-4 py-5'}>
      <div className="flex flex-col items-center gap-3 text-center">
        <AgentGlyph />
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <p className="max-w-xl text-sm text-text-secondary">{description}</p>
          {meta ? <p className="text-xs text-text-tertiary">{meta}</p> : null}
        </div>

        <div className="grid w-full gap-2 text-left sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-md border border-border bg-bg-primary px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-text-tertiary">{stat.label}</div>
              <div
                className={[
                  'mt-1 truncate text-sm font-semibold',
                  stat.mono ? 'font-mono tabular-nums' : '',
                  toneClass[stat.tone ?? 'default'],
                ].join(' ')}
                title={typeof stat.value === 'string' ? stat.value : undefined}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {(primaryAction || secondaryAction) ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {primaryAction ? <StateActionButton action={primaryAction} /> : null}
            {secondaryAction ? <StateActionButton action={secondaryAction} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
