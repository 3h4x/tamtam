'use client'

import { ProjectsProvider, useProjects } from '@/components/ProjectsProvider'
import { ToastProvider } from '@/components/Toast'
import { Header } from '@/components/Header'
import { ErrorBanner } from '@/components/ErrorBanner'

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { loading, lastRefresh, error, setError } = useProjects()

  return (
    <div className="min-h-screen flex flex-col bg-bg-primary text-text-primary">
      <Header loading={loading} lastRefresh={lastRefresh} />
      <main className="flex-1 p-4 sm:p-6">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {children}
      </main>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ProjectsProvider>
        <AppShellInner>{children}</AppShellInner>
      </ProjectsProvider>
    </ToastProvider>
  )
}
