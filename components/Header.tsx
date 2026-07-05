'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'
import { NotificationBell } from './NotificationBell'
import { PrivacyToggle } from './PrivacyToggle'
import { JobsPauseToggle } from './JobsPauseToggle'
import { Button, buttonVariants } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { Spinner } from '@/components/ui/Spinner'
import { fetchInbox } from '@/lib/client-api'
import { useTheme } from '@/hooks/useTheme'

interface HeaderProps {
  loading: boolean
  lastRefresh: number
}

interface NavItem {
  to: string
  label: string
  // When set, the nav item shows this Map's value as a count chip — same
  // pattern as `Issues / PRs 10` on the project tab nav. The chip is hidden
  // when the count is 0 to avoid noise.
  countKey?: 'inbox'
}

// Inbox is the single cross-project triage surface: it now merges the derived
// signals with the open recommendations (which used to be their own nav entry
// + page) into one tabbed page (Inbox / Initiatives / History). `/recommendations`
// redirects to `/inbox` (see next.config.ts).
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Projects' },
  { to: '/inbox', label: 'Inbox', countKey: 'inbox' },
  { to: '/monitoring', label: 'Monitoring' },
  { to: '/runs', label: 'Runs' },
  { to: '/workflow-runs', label: 'Workflows' },
  { to: '/stats', label: 'Stats' },
  { to: '/library', label: 'Library' },
  { to: '/agent', label: 'Agent' },
  { to: '/settings', label: 'Settings' },
]

export function Header({ loading, lastRefresh: _lastRefresh }: HeaderProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { theme } = useTheme()
  const logoSrc = theme === 'dark' ? '/logo-light.png' : '/logo.png'

  // Count of red (urgent) inbox signals, polled on a 60s cadence and refreshed
  // immediately when an inbox action fires. Chip hidden when 0; fail-open on error.
  // Recommendations fold into the merged feed as yellow/green, so they don't
  // affect this red-blockers-only badge (the merged red count equals the inbox
  // red count — recommendations are never red — so the lighter /api/inbox read
  // still yields the right number for the badge).
  const [inboxRed, setInboxRed] = useState<number>(0)
  useEffect(() => {
    let live = true
    const load = () => {
      fetchInbox()
        .then((r) => { if (live) setInboxRed(r.counts.red) })
        .catch(() => { if (live) setInboxRed(0) })
    }
    load()
    const id = setInterval(load, 60_000)
    window.addEventListener('tamtam:inbox-changed', load)
    return () => { live = false; clearInterval(id); window.removeEventListener('tamtam:inbox-changed', load) }
  }, [])
  const counts: Record<string, number> = { inbox: inboxRed }
  const [authConfigured, setAuthConfigured] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/auth/check')
      .then((res) => res.json().catch(() => ({})))
      .then((body) => {
        if (live) setAuthConfigured(body.configured === true)
      })
      .catch(() => {
        if (live) setAuthConfigured(false)
      })
    return () => { live = false }
  }, [])

  async function logout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      router.replace('/login')
      router.refresh()
    }
  }

  return (
    <header className="sticky top-0 z-50 flex flex-wrap sm:flex-nowrap items-center px-3 sm:px-6 py-2 border-b border-border bg-bg-primary gap-x-2 gap-y-1 min-w-0">
      <div className="overflow-hidden shrink-0 -my-1" style={{ height: 36 }}>
        <img src={logoSrc} alt="tamtam" width={122} height={52} style={{ height: 52, width: 122, marginTop: -8, display: 'block' }} />
      </div>
      <nav className="order-3 sm:order-none flex flex-1 basis-full sm:basis-auto min-w-0 items-center gap-0.5 overflow-x-auto scrollbar-none" aria-label="Global sections">
        {NAV_ITEMS.map((item) => {
          const isActive = item.to === '/'
            ? pathname === '/'
            : pathname === item.to || pathname.startsWith(item.to + '/')
          const count = item.countKey ? counts[item.countKey] ?? 0 : 0
          return (
            <Link
              key={item.to}
              href={item.to}
              className={buttonVariants({
                variant: isActive ? 'primary' : 'ghost',
                className: `!px-2.5 sm:!px-3 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                  isActive ? '!border-transparent bg-accent-light !font-medium hover:!bg-accent-light' : ''
                }`,
              })}
            >
              {item.label}
              {item.countKey && count > 0 && (
                <Pill
                  tone={item.countKey === 'inbox' ? 'error' : 'accent'}
                  size="xs"
                  className="min-w-[1.25rem] justify-center rounded-full border-transparent px-1.5 py-0 text-[10px] font-mono font-normal tabular-nums leading-4"
                  aria-label={
                    item.countKey === 'inbox'
                      ? `${count} urgent inbox signal${count === 1 ? '' : 's'}`
                      : `${count} open recommendation${count === 1 ? '' : 's'}`
                  }
                >
                  {count}
                </Pill>
              )}
            </Link>
          )
        })}
      </nav>
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        {loading && <Spinner size="md" shrink className="text-text-tertiary" aria-label="Loading" role="status" />}
        <PrivacyToggle />
        <JobsPauseToggle />
        <NotificationBell />
        <ThemeToggle />
        {authConfigured && (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="h-8 w-8 bg-transparent text-text-secondary hover:border-text-tertiary hover:text-text-primary"
            onClick={logout}
            disabled={loggingOut}
            disabledCursor="wait"
            title="Sign out"
            aria-label="Sign out"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
              <path d="M10.5 11.5 14 8l-3.5-3.5" />
              <path d="M14 8H6" />
            </svg>
          </Button>
        )}
      </div>
    </header>
  )
}
