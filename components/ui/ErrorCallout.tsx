'use client'

import type { ComponentPropsWithoutRef, ReactNode } from 'react'

interface ErrorCalloutProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode
  className?: string
  padding?: 'none' | 'sm' | 'md'
  radius?: 'default' | 'md' | 'lg'
  tone?: 'error' | 'warning'
  preWrap?: boolean
}

const TONE = {
  error: 'border border-status-error/30 bg-status-error/10 text-status-error',
  warning: 'border border-status-warning/30 bg-status-warning/10 text-status-warning',
}
const PADDING = {
  none: '',
  sm: 'p-2',
  md: 'p-3',
}
const RADIUS = {
  default: 'rounded',
  md: 'rounded-md',
  lg: 'rounded-lg',
}

/**
 * Inline error-message block: renders error text inside a small red, pre-wrapped
 * callout box. For full-panel load failures use ErrorState; for dismissible
 * banners use ErrorBanner.
 */
export function ErrorCallout({
  children,
  className,
  padding = 'sm',
  radius = 'default',
  tone = 'error',
  preWrap = true,
  ...props
}: ErrorCalloutProps) {
  return (
    <div className={[
      TONE[tone],
      RADIUS[radius],
      PADDING[padding],
      preWrap ? 'whitespace-pre-wrap' : undefined,
      className,
    ].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  )
}
