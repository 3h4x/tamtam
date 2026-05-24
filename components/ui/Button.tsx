'use client'

import React from 'react'

export type ButtonVariant =
  | 'secondary'   // bordered neutral — the default workhorse
  | 'primary'     // translucent accent (border + bg/10)
  | 'solid'       // solid accent fill — marquee save/submit actions
  | 'success-solid'// solid green — completed confirmations
  | 'ghost'       // transparent, text-secondary — nav links, separators
  | 'danger'      // error text + hover fill — "Delete" before confirmation
  | 'danger-solid'// solid red — confirmed destructive action
  | 'warning'     // amber border + translucent bg
  | 'info'        // blue border + translucent bg

export type ButtonSize = 'sm' | 'md'
export type ButtonDisabledCursor = 'not-allowed' | 'default' | 'wait'

const BASE =
  'inline-flex items-center gap-1.5 font-medium transition-colors cursor-pointer no-underline disabled:opacity-50'

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs rounded',
  md: 'px-3 py-1.5 text-sm rounded-md',
}

const VARIANT: Record<ButtonVariant, string> = {
  secondary:    'border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary',
  primary:      'border border-accent bg-accent/10 text-accent hover:bg-accent/20',
  solid:        'border border-transparent bg-accent text-white hover:bg-accent-hover',
  'success-solid':'border border-transparent bg-status-success text-white hover:bg-status-success',
  ghost:        'border border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/60',
  danger:       'border border-status-error text-status-error hover:bg-status-error/10',
  'danger-solid':'border border-transparent bg-status-error text-white hover:bg-status-error/90',
  warning:      'border border-status-warning/60 bg-status-warning/10 text-status-warning hover:bg-status-warning/20',
  info:         'border border-status-info/50 bg-status-info/10 text-status-info hover:bg-status-info/20',
}

const DISABLED_CURSOR: Record<ButtonDisabledCursor, string> = {
  'not-allowed': 'disabled:cursor-not-allowed',
  default:       'disabled:cursor-default',
  wait:          'disabled:cursor-wait',
}

export function buttonVariants({
  variant = 'secondary',
  size = 'md',
  disabledCursor = 'not-allowed',
  className,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  disabledCursor?: ButtonDisabledCursor
  className?: string
} = {}): string {
  return [BASE, SIZE[size], VARIANT[variant], DISABLED_CURSOR[disabledCursor], className].filter(Boolean).join(' ')
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  disabledCursor?: ButtonDisabledCursor
}

export function Button({
  variant = 'secondary',
  size = 'md',
  disabledCursor = 'not-allowed',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonVariants({ variant, size, disabledCursor, className })}
      {...props}
    />
  )
}
