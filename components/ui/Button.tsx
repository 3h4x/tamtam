'use client'

import React from 'react'

export type ButtonVariant =
  | 'secondary'   // bordered neutral — the default workhorse
  | 'primary'     // translucent accent (border + bg/10)
  | 'solid'       // solid accent fill — marquee save/submit actions
  | 'success'     // success text + hover fill — positive toggles
  | 'success-solid'// solid green — completed confirmations
  | 'ghost'       // transparent, text-secondary — nav links, separators
  | 'danger'      // error text + hover fill — "Delete" before confirmation
  | 'danger-solid'// solid red — confirmed destructive action
  | 'warning'     // amber border + translucent bg
  | 'info'        // blue border + translucent bg
  | 'link'        // inline text-accent link — for inline prose/header actions

export type ButtonSize = 'sm' | 'md' | 'icon-sm'
export type ButtonDisabledCursor = 'not-allowed' | 'default' | 'wait'
export type ButtonSurface = 'secondary' | 'primary'

const BASE =
  'inline-flex items-center gap-1.5 font-medium transition-colors cursor-pointer no-underline disabled:opacity-50'

const LINK_BASE =
  'inline cursor-pointer text-accent hover:underline transition-colors disabled:opacity-50'

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs rounded',
  md: 'px-3 py-1.5 text-sm rounded-md',
  'icon-sm': 'h-6 w-6 justify-center rounded-md p-0 text-sm',
}

const LINK_TEXT_SIZE: Record<ButtonSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  'icon-sm': 'text-sm',
}

const SECONDARY_SURFACE: Record<ButtonSurface, string> = {
  secondary: 'bg-bg-secondary text-text-primary',
  primary: 'bg-bg-primary text-text-secondary hover:text-text-primary',
}

const VARIANT: Record<Exclude<ButtonVariant, 'link' | 'secondary'>, string> = {
  primary:      'border border-accent bg-accent/10 text-accent hover:bg-accent/20',
  solid:        'border border-transparent bg-accent text-white hover:bg-accent-hover',
  success:      'border border-status-success text-status-success hover:bg-status-success/10',
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
  surface = 'secondary',
  className,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  disabledCursor?: ButtonDisabledCursor
  surface?: ButtonSurface
  className?: string
} = {}): string {
  if (variant === 'link') {
    return [LINK_BASE, LINK_TEXT_SIZE[size], DISABLED_CURSOR[disabledCursor], className].filter(Boolean).join(' ')
  }
  const variantClass = variant === 'secondary'
    ? ['border border-border hover:bg-bg-tertiary', SECONDARY_SURFACE[surface]].join(' ')
    : VARIANT[variant]
  return [BASE, SIZE[size], variantClass, DISABLED_CURSOR[disabledCursor], className].filter(Boolean).join(' ')
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  disabledCursor?: ButtonDisabledCursor
  surface?: ButtonSurface
}

export function Button({
  variant = 'secondary',
  size = 'md',
  disabledCursor = 'not-allowed',
  surface = 'secondary',
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonVariants({ variant, size, disabledCursor, surface, className })}
      {...props}
    />
  )
}
