'use client'

import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  paddingY?: 'sm' | 'md' | 'lg'
  bordered?: boolean
  className?: string
}

const PADDING: Record<NonNullable<EmptyStateProps['paddingY']>, string> = {
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
  bordered = false,
  className,
}: EmptyStateProps) {
  const border = bordered ? 'rounded-md border border-dashed border-border bg-bg-secondary' : ''
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 gap-2 text-center ${PADDING[paddingY]} ${border} ${className ?? ''}`}
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
