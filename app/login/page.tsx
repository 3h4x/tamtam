'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { ErrorCallout } from '@/components/ui/ErrorCallout'
import { Input } from '@/components/ui/Input'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || 'Invalid token')
      }
      router.replace(searchParams.get('next') || '/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
      <form onSubmit={submit} className="rounded-lg border border-border bg-bg-secondary p-5">
        <h1 className="text-lg font-semibold text-text-primary">TamTam Login</h1>
        <p className="mt-1 text-sm text-text-tertiary">Enter the shared auth token for this TamTam instance.</p>
        <label className="mt-5 block text-xs font-medium text-text-secondary">Auth token</label>
        <Input
          className="mt-1"
          type="password"
          value={token}
          autoFocus
          onChange={(e) => setToken(e.target.value)}
        />
        {error && (
          <ErrorCallout padding="none" preWrap={false} className="mt-3 border-0 bg-transparent text-sm">
            {error}
          </ErrorCallout>
        )}
        <Button type="submit" className="mt-5 w-full justify-center" disabled={submitting || !token.trim()}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}

// useSearchParams() requires a Suspense boundary during static prerender
// (Next.js CSR bailout). Wrap the form so `/login` can be statically exported.
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
