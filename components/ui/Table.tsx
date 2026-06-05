'use client'

import React, { useState } from 'react'
import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  label: string
  title?: string
  sortable?: boolean
  sortValue?: (row: T) => number | string
  // Direction applied the first time this column is selected for sorting.
  // Defaults to 'asc'; numeric columns commonly want 'desc' first.
  initialSortDir?: 'asc' | 'desc'
  render: (row: T) => ReactNode
  cellTitle?: (row: T) => string
  headerClass?: string
  cellClass?: string
}

interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  getRowKey: (row: T) => string
  rowId?: (row: T) => string
  rowClassName?: (row: T) => string
  onRowClick?: (row: T) => void
  defaultSortKey?: string
  defaultSortDir?: 'asc' | 'desc'
  emptyState?: ReactNode
  className?: string
  tableClassName?: string
  tableTextClassName?: string
  cellPaddingClassName?: string
  bordered?: boolean
  showHeader?: boolean
  expandedRender?: (row: T) => ReactNode
  // Optional <tfoot> content (e.g. a totals row). Rendered verbatim inside
  // a <tfoot> after the body; supply a <tr> with cells matching the columns.
  footer?: ReactNode
}

export function Table<T>({
  columns,
  rows,
  getRowKey,
  rowId,
  rowClassName,
  onRowClick,
  defaultSortKey = '',
  defaultSortDir = 'asc',
  emptyState,
  className,
  tableClassName,
  tableTextClassName = 'text-sm',
  cellPaddingClassName = 'px-3 py-2.5',
  bordered = true,
  showHeader = true,
  expandedRender,
  footer,
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState(defaultSortKey)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir)

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(columns.find(c => c.key === key)?.initialSortDir ?? 'asc')
    }
  }

  // Resolve the sort column once to avoid doing a
  // columns.find() on every pair (O(N log N × M) where M is columns.length).
  // Also short-circuit the array copy when there's nothing to sort.
  const sortCol = sortKey ? columns.find(c => c.key === sortKey) : undefined
  const sortValueFn = sortCol?.sortValue ?? null
  const sorted = sortValueFn === null
    ? rows
    : [...rows].sort((a, b) => {
        const av = sortValueFn(a)
        const bv = sortValueFn(b)
        if (av === bv) return 0
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })

  return (
    <div className={[
      'overflow-x-auto',
      bordered ? 'rounded-lg border border-border' : '',
      className ?? '',
    ].filter(Boolean).join(' ')}>
      <table className={`w-full ${tableTextClassName} ${tableClassName ?? ''}`}>
        {showHeader && (
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
                  title={col.title}
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
        )}
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
              const clickable = onRowClick !== undefined
              return (
                <React.Fragment key={getRowKey(row)}>
                  <tr
                    id={rowId?.(row)}
                    className={[
                      'border-b border-border last:border-0 transition-colors hover:bg-bg-secondary/40',
                      clickable ? 'cursor-pointer' : '',
                      rowClassName?.(row) ?? '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={clickable ? () => onRowClick(row) : undefined}
                  >
                    {columns.map(col => (
                      <td
                        key={col.key}
                        className={`${cellPaddingClassName} ${col.cellClass ?? ''}`}
                        title={col.cellTitle?.(row)}
                      >
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
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
