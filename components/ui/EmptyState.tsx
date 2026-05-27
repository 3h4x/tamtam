'use client'

import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  paddingY?: 'sm' | 'md' | 'lg'
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
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 gap-2 text-center ${PADDING[paddingY]} ${className ?? ''}`}
    >
      {icon}
      <p className="text-sm text-text-secondary">{title}</p>
      {description && (
        <p className="text-xs text-text-tertiary max-w-md">{description}</p>
      )}
      {action}
    </div>
  )
}
