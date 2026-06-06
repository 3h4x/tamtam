'use client'

import type { ReactNode } from 'react'

interface ErrorCalloutProps {
  children: ReactNode
  className?: string
  padding?: 'sm' | 'md'
  radius?: 'default' | 'md' | 'lg'
  preWrap?: boolean
}

const BASE = 'border border-status-error/30 bg-status-error/10 text-status-error'
const PADDING = {
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
  preWrap = true,
}: ErrorCalloutProps) {
  return (
    <div className={[
      BASE,
      RADIUS[radius],
      PADDING[padding],
      preWrap ? 'whitespace-pre-wrap' : undefined,
      className,
    ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  )
}
