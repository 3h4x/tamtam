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
  onChange: (tab: T) => void
}

export function StandardTabs<T extends string>({
  items,
  activeTab,
  ariaLabel,
  className = '',
  onChange,
}: StandardTabsProps<T>) {
  const tabClass = (tab: T) =>
    `relative shrink-0 px-3 py-1.5 text-sm cursor-pointer transition-colors focus:outline-none focus-visible:text-text-primary ${
      activeTab === tab
        ? 'border-b-2 border-accent text-accent font-medium -mb-px'
        : 'border-b-2 border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/40 -mb-px'
    }`

  return (
    <nav
      className={`flex min-w-0 gap-1 overflow-x-auto scrollbar-none border-b border-border ${className}`}
      aria-label={ariaLabel}
    >
      {items.map((item) => (
        <button
          key={item.id}
          className={tabClass(item.id)}
          onClick={() => {
            if (item.onClick) {
              item.onClick()
              return
            }
            onChange(item.id)
          }}
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
    </nav>
  )
}
