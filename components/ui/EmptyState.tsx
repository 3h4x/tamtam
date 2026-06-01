'use client'

import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  paddingY?: 'none' | 'xs' | 'sm' | 'md' | 'lg'
  paddingX?: 'none' | 'sm' | 'md'
  align?: 'center' | 'start'
  actionLayout?: 'stack' | 'inline'
  bordered?: boolean
  className?: string
}

const PADDING: Record<NonNullable<EmptyStateProps['paddingY']>, string> = {
  none: '',
  xs: 'py-6',
  sm: 'py-8',
  md: 'py-12',
  lg: 'py-20',
}

const PADDING_X: Record<NonNullable<EmptyStateProps['paddingX']>, string> = {
  none: '',
  sm: 'px-3',
  md: 'px-6',
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  paddingY = 'md',
  paddingX = 'md',
  align = 'center',
  actionLayout = 'stack',
  bordered = false,
  className,
}: EmptyStateProps) {
  const border = bordered ? 'rounded-md border border-dashed border-border bg-bg-secondary' : ''
  const alignment = align === 'start'
    ? 'items-start text-left'
    : 'items-center justify-center text-center'
  const inlineAlignment = align === 'start' ? 'text-left' : 'text-center'

  if (actionLayout === 'inline') {
    return (
      <div
        className={`flex items-center justify-between gap-3 ${PADDING_X[paddingX]} ${PADDING[paddingY]} ${border} ${className ?? ''}`}
      >
        <div className={inlineAlignment}>
          {icon}
          <p className="text-sm font-medium text-text-primary">{title}</p>
          {description && (
            <p className="mt-0.5 text-xs text-text-tertiary max-w-md">{description}</p>
          )}
        </div>
        {action}
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col ${PADDING_X[paddingX]} gap-2 ${alignment} ${PADDING[paddingY]} ${border} ${className ?? ''}`}
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
