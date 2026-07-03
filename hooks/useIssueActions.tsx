'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { GhIssue } from '@/lib/client-api'

// Shared issue action logic for the Issues tab: opening an issue in the
// terminal (Work on / discuss) and resuming a prior provider session
// (Continue). Used by both the compact IssueRow buttons and the issue detail
// drawer so the two surfaces stay behaviourally identical.
export function useIssueActions(issue: GhIssue, projectName: string) {
  const router = useRouter()
  const [continuing, setContinuing] = useState(false)
  const hasContext = issue.hasContext === true

  // Issue bodies can be many KB. Stuffing them into the URL trips Node's
  // 8KB header limit (HTTP 431) before the terminal page even renders, so
  // we stash the payload in sessionStorage and pass only the short key.
  const stashAndOpen = useCallback(
    (data: { prompt: string; issue_number?: string; issue_repo?: string; issue_title?: string; resume_session_id?: string; resume_provider?: string }) => {
      const key = `tamtam-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try { sessionStorage.setItem(key, JSON.stringify(data)) } catch {}
      router.push(`/project/${projectName}/terminal?pending=${key}`)
    },
    [projectName, router],
  )

  const repo = useMemo(() => {
    const m = issue.url.match(/github\.com\/([^/]+\/[^/]+)\/issues\//)
    return m?.[1] ?? ''
  }, [issue.url])

  const openInTerminal = useCallback(() => {
    const prompt = `Work on GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}`
    stashAndOpen({
      prompt,
      issue_number: String(issue.number),
      issue_repo: repo,
      issue_title: issue.title,
    })
  }, [issue.number, issue.title, issue.url, issue.body, repo, stashAndOpen])

  const discussInTerminal = useCallback(() => {
    const prompt = `Let's discuss GitHub issue #${issue.number}: "${issue.title}" (${issue.url})\n\n${issue.body || ''}\n\nHelp me think through this issue — the requirements, edge cases, possible approaches, and any open questions.`
    stashAndOpen({ prompt })
  }, [issue.number, issue.title, issue.url, issue.body, stashAndOpen])

  const continueWork = useCallback(async () => {
    if (continuing) return
    setContinuing(true)
    try {
      const res = await fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/continue-issue?issue_number=${issue.number}`)
      if (!res.ok) throw new Error('continue-issue lookup failed')
      const data = await res.json() as { sessionId: string | null; provider: string | null; prompt: string; unverifiedCount: number }
      stashAndOpen({
        prompt: data.prompt,
        issue_number: String(issue.number),
        issue_repo: repo,
        issue_title: issue.title,
        resume_session_id: data.sessionId ?? undefined,
        resume_provider: data.provider ?? undefined,
      })
    } catch {
      // Fall back to a plain Work-on if the lookup failed.
      openInTerminal()
    } finally {
      setContinuing(false)
    }
  }, [continuing, projectName, issue.number, issue.title, repo, stashAndOpen, openInTerminal])

  return { hasContext, continuing, openInTerminal, discussInTerminal, continueWork }
}
