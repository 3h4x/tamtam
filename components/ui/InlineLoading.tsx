'use client'

import { Spinner } from '@/components/ui/Spinner'

interface InlineLoadingProps {
  label: string
  className?: string
}

export function InlineLoading({ label, className }: InlineLoadingProps) {
  return (
    <div
      className={[
        'flex items-center gap-2 text-sm text-text-tertiary',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Spinner size="sm" shrink aria-label="Loading" role="status" />
      <span>{label}</span>
    </div>
  )
}
