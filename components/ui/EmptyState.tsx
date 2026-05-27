'use client'

import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  paddingY?: 'xs' | 'sm' | 'md' | 'lg'
  align?: 'center' | 'start'
  bordered?: boolean
  className?: string
}

const PADDING: Record<NonNullable<EmptyStateProps['paddingY']>, string> = {
  xs: 'py-6',
  sm: 'py-8',
  md: 'py-12',
  lg: 'py-20',
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  paddingY = 'md',
  align = 'center',
  bordered = false,
  className,
}: EmptyStateProps) {
  const border = bordered ? 'rounded-md border border-dashed border-border bg-bg-secondary' : ''
  const alignment = align === 'start'
    ? 'items-start text-left'
    : 'items-center justify-center text-center'

  return (
    <div
      className={`flex flex-col px-6 gap-2 ${alignment} ${PADDING[paddingY]} ${border} ${className ?? ''}`}
    >
      {icon}
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {description && (
        <p className="text-xs text-text-tertiary max-w-md">{description}</p>
      )}
      {action}
    </div>
  )
}
