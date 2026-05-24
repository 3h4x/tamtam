'use client'

import type { HTMLAttributes } from 'react'

interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  color?: 'current' | 'accent' | 'white'
  shrink?: boolean
}

const SIZE_CLASSES = {
  xs: 'w-2 h-2 border',
  sm: 'w-2.5 h-2.5 border-2',
  md: 'w-3 h-3 border-2',
  lg: 'w-3.5 h-3.5 border-2',
  xl: 'w-4 h-4 border-2',
} as const

const COLOR_CLASSES = {
  current: 'border-current',
  accent: 'border-accent',
  white: 'border-white',
} as const

export function Spinner({ size = 'md', color = 'current', shrink, className, ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      className={[
        'inline-block rounded-full border-t-transparent animate-spin',
        SIZE_CLASSES[size],
        COLOR_CLASSES[color],
        shrink ? 'shrink-0' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    />
  )
}
