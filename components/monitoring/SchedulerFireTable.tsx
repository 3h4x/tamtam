'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Table } from '@/components/ui/Table'
import type { Column } from '@/components/ui/Table'

export interface SchedulerInternalEntry {
  agentId: string
  project: string
  name: string
  schedule: string
  enabled: boolean
  nextFireMs: number
  lastFireMs: number | null
  lastJobMs: number | null
  fireCount: number
  errorCount: number
  lastError: string | null
}

function fmtRelative(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const diff = ms - now
  const abs = Math.abs(diff)
  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  let label: string
  if (sec < 60) label = `${sec}s`
  else if (min < 60) label = `${min}m`
  else if (hr < 48) label = `${hr}h`
  else label = `${Math.round(hr / 24)}d`
  return diff < 0 ? `${label} ago` : `in ${label}`
}

export function SchedulerFireTable({ entries }: { entries: SchedulerInternalEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const now = Date.now()
  const sorted = [...entries].sort((a, b) => {
    if (a.lastError && !b.lastError) return -1
    if (!a.lastError && b.lastError) return 1
    return a.nextFireMs - b.nextFireMs
  })
  const overdue = sorted.filter(e => e.nextFireMs < now)
  const visible = showAll ? sorted : sorted.slice(0, 8)
  const columns: Column<SchedulerInternalEntry>[] = [
    {
      key: 'agent',
      label: 'Agent',
      headerClass: '!py-1.5 !text-[10px] w-full',
      cellClass: '!py-1.5 text-xs font-mono w-full max-w-0 overflow-hidden',
      render: e => <span className="block min-w-0 truncate text-text-primary" data-private>{e.project}/{e.name}</span>,
      cellTitle: e => e.lastError ?? '',
    },
    {
      key: 'schedule',
      label: 'Sched',
      headerClass: '!py-1.5 !text-[10px] w-[4.5rem]',
      cellClass: '!py-1.5 text-xs font-mono whitespace-nowrap w-[4.5rem]',
      render: e => <span className="text-text-tertiary">{e.schedule}</span>,
      cellTitle: e => e.lastError ?? '',
    },
    {
      key: 'next',
      label: 'Next',
      headerClass: '!py-1.5 !text-[10px] w-[4.75rem]',
      cellClass: '!py-1.5 text-xs font-mono whitespace-nowrap w-[4.75rem]',
      render: e => {
        const isOverdue = e.nextFireMs < now
        return <span className={isOverdue ? 'text-status-warning' : 'text-text-secondary'}>{fmtRelative(e.nextFireMs, now)}</span>
      },
      cellTitle: e => e.lastError ?? '',
    },
    {
      key: 'last',
      label: 'Last',
      headerClass: '!py-1.5 !text-[10px] w-[4.75rem]',
      cellClass: '!py-1.5 text-xs font-mono whitespace-nowrap w-[4.75rem]',
      render: e => (
        <span className={(e.lastJobMs ?? e.lastFireMs) === null ? 'text-text-tertiary' : 'text-text-secondary'}>
          {fmtRelative(e.lastJobMs ?? e.lastFireMs, now)}
        </span>
      ),
      cellTitle: e => e.lastError ?? '',
    },
    {
      key: 'fires',
      label: 'Fires',
      headerClass: '!py-1.5 !text-[10px] w-[4rem]',
      cellClass: '!py-1.5 text-xs font-mono whitespace-nowrap w-[4rem]',
      render: e => (
        <span className={e.errorCount > 0 ? 'text-status-error' : 'text-text-secondary'}>
          {e.fireCount}{e.errorCount > 0 ? `/${e.errorCount}!` : ''}
        </span>
      ),
      cellTitle: e => e.lastError ?? '',
    },
  ]

  return (
    <div>
      <h3 className="text-xs font-medium text-text-secondary mb-1">
        Fire history
        {overdue.length > 0 && (
          <span className="ml-2 text-status-warning">({overdue.length} overdue)</span>
        )}
      </h3>
      <Table
        columns={columns}
        rows={visible}
        getRowKey={e => e.agentId}
        rowClassName={e => e.lastError ? 'bg-status-error/5' : ''}
        className="rounded-md text-xs [&_table]:table-fixed"
      />
      {sorted.length > 8 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(v => !v)}
          className="mt-1 !px-0 !py-0 text-[11px] font-normal text-text-tertiary hover:!bg-transparent hover:text-text-secondary"
        >
          {showAll ? 'Show less' : `Show all ${sorted.length}`}
        </Button>
      )}
    </div>
  )
}
