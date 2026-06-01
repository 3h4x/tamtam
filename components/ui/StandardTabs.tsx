'use client'

import type { ReactNode } from 'react'

export interface StandardTabItem<T extends string> {
  id: T
  label: ReactNode
  mobileLabel?: ReactNode
  badge?: ReactNode
  indicator?: ReactNode
  ariaLabel?: string
  title?: string
  onClick?: () => void
}

export interface StandardTabsProps<T extends string> {
  items: StandardTabItem<T>[]
  activeTab: T
  ariaLabel: string
  className?: string
  variant?: 'navigation' | 'tabs'
  onChange: (tab: T) => void
}

export function StandardTabs<T extends string>({
  items,
  activeTab,
  ariaLabel,
  className = '',
  variant = 'navigation',
  onChange,
}: StandardTabsProps<T>) {
  const Container = variant === 'tabs' ? 'div' : 'nav'
  const tabClass = (tab: T) =>
    `relative shrink-0 px-3 py-1.5 text-sm cursor-pointer transition-colors focus:outline-none focus-visible:text-text-primary ${
      activeTab === tab
        ? 'border-b-2 border-accent text-accent font-medium -mb-px'
        : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/40 -mb-px'
    }`

  return (
    <Container
      className={`flex min-w-0 gap-1 overflow-x-auto scrollbar-none border-b border-border ${className}`}
      aria-label={ariaLabel}
      role={variant === 'tabs' ? 'tablist' : undefined}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={tabClass(item.id)}
          onClick={() => {
            if (item.onClick) {
              item.onClick()
              return
            }
            onChange(item.id)
          }}
          role={variant === 'tabs' ? 'tab' : undefined}
          aria-selected={variant === 'tabs' ? activeTab === item.id : undefined}
          aria-current={variant === 'navigation' && activeTab === item.id ? 'page' : undefined}
          aria-label={item.ariaLabel}
          title={item.title}
        >
          {item.mobileLabel == null ? (
            item.label
          ) : (
            <>
              <span className="sm:hidden">{item.mobileLabel}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </>
          )}
          {item.badge}
          {item.indicator}
        </button>
      ))}
    </Container>
  )
}
