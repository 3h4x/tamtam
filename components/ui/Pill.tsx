'use client'

import React from 'react'

export type PillTone = 'neutral' | 'accent' | 'success' | 'error' | 'warning' | 'info'
export type PillSize = 'xs' | 'sm'
export type PillInactiveStyle = 'transparent' | 'subtle'

const BASE =
  'inline-flex items-center gap-1.5 border font-medium transition-colors'

const SIZE: Record<PillSize, string> = {
  xs: 'rounded-md px-2 py-0.5 text-xs',
  sm: 'rounded-md px-2 py-1 text-xs',
}

const TONE: Record<PillTone, string> = {
  neutral: 'border-border bg-bg-primary text-text-secondary',
  accent: 'border-accent bg-accent/10 text-accent',
  success: 'border-status-success/30 bg-status-success/15 text-status-success',
  error: 'border-status-error/30 bg-status-error/15 text-status-error',
  warning: 'border-status-warning/30 bg-status-warning/15 text-status-warning',
  info: 'border-status-info/30 bg-status-info/15 text-status-info',
}

const INACTIVE: Record<PillInactiveStyle, string> = {
  transparent: 'border-transparent bg-transparent text-text-secondary',
  subtle: 'border-border bg-bg-primary text-text-secondary',
}
const CLICKABLE = 'cursor-pointer'
const INACTIVE_CLICKABLE = 'hover:border-border hover:bg-bg-primary hover:text-text-primary'

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone
  size?: PillSize
  active?: boolean
  inactiveStyle?: PillInactiveStyle
}

export function Pill({
  tone = 'neutral',
  size = 'sm',
  active = true,
  inactiveStyle = 'transparent',
  className,
  ...props
}: PillProps) {
  return (
    <span
      className={[BASE, SIZE[size], active ? TONE[tone] : INACTIVE[inactiveStyle], className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}

export interface PillButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: PillTone
  size?: PillSize
  active?: boolean
  inactiveStyle?: PillInactiveStyle
}

export function PillButton({
  tone = 'neutral',
  size = 'sm',
  active = false,
  inactiveStyle = 'transparent',
  className,
  ...props
}: PillButtonProps) {
  return (
    <button
      className={[
        BASE,
        SIZE[size],
        active ? TONE[tone] : INACTIVE[inactiveStyle],
        CLICKABLE,
        active ? undefined : INACTIVE_CLICKABLE,
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
