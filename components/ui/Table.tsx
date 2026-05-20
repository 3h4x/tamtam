'use client'

import React, { useState } from 'react'
import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  label: string
  sortable?: boolean
  sortValue?: (row: T) => number | string
  render: (row: T) => ReactNode
  headerClass?: string
  cellClass?: string
}

interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  defaultSortKey?: string
  defaultSortDir?: 'asc' | 'desc'
  emptyState?: ReactNode
  className?: string
  expandedRender?: (row: T) => ReactNode
}

export function Table<T>({
  columns,
  rows,
  getRowKey,
  defaultSortKey = '',
  defaultSortDir = 'asc',
  emptyState,
  className,
  expandedRender,
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSortKey)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir)

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = [...rows].sort((a, b) => {
    if (!sortKey) return 0
    const col = columns.find(c => c.key === sortKey)
    if (!col?.sortValue) return 0
    const av = col.sortValue(a)
    const bv = col.sortValue(b)
    if (av === bv) return 0
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  })

  return (
    <div className={`overflow-x-auto rounded-lg border border-border ${className ?? ''}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-bg-secondary">
            {columns.map(col => (
              <th
                key={col.key}
                className={[
                  'px-3 py-2 text-left text-xs font-semibold text-text-secondary uppercase tracking-wider whitespace-nowrap',
                  col.sortable ? 'cursor-pointer select-none hover:text-text-primary' : '',
                  col.headerClass ?? '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortable && (
                    <span
                      className={`text-[10px] ${sortKey === col.key ? 'text-accent' : 'text-text-tertiary'}`}
                    >
                      {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            emptyState ? (
              <tr>
                <td colSpan={columns.length}>{emptyState}</td>
              </tr>
            ) : null
          ) : (
            sorted.map(row => {
              const expanded = expandedRender ? expandedRender(row) : null
              return (
                <React.Fragment key={getRowKey(row)}>
                  <tr className="border-b border-border last:border-0 transition-colors hover:bg-bg-secondary/40">
                    {columns.map(col => (
                      <td key={col.key} className={`px-3 py-2.5 ${col.cellClass ?? ''}`}>
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                  {expanded && (
                    <tr className="border-b border-border last:border-0 bg-bg-secondary/30">
                      <td colSpan={columns.length} className="px-3 py-3">
                        {expanded}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
