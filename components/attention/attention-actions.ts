// Unified action dispatch for the merged Inbox feed. One entry point that routes
// an AttentionItem's action to the SAME per-project endpoints the old InboxFeed
// (`runSignalAction`) and GlobalRecommendationsPage handlers used — no new
// mutation surface. Returns a success message for the toast, or throws.
// AttentionRow owns busy state / toast / the `tamtam:inbox-changed` event.

import {
  fixCi,
  releaseProject,
  reviewProject,
  mergePR,
  resolveConflicts,
  resumeProject,
  retryAutomationQueue,
  updateRecommendation,
  runAgent,
  updateAgent,
} from '@/lib/client-api'
import type { AttentionItem, AttentionAction } from '@/lib/attention/types'

const INVESTIGATE_PROMPT =
  'Your recent scheduled runs produced no file changes. Investigate why: review the ' +
  'project state and your own task scope, and report whether there is genuinely no ' +
  'actionable work, the prompt is too narrow, or something is blocking you from making ' +
  'changes. Do not modify any files — report your findings only.'

// The apply endpoint only needs the recommendation id (the server does the work
// + resolves the row); mirrors client-api `applyRecommendation` minus its
// redundant client-side validation, which the server also performs.
async function applyRecommendationById(project: string, id: string): Promise<void> {
  const res = await fetch(`/api/projects/by-project/${encodeURIComponent(project)}/recommendations/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to apply recommendation')
  }
}

async function dispatchSignal(item: AttentionItem, action: AttentionAction): Promise<string> {
  const project = item.project
  switch (action.kind) {
    case 'fix-ci':
      await fixCi(project)
      return `Started CI fix for ${project}`
    case 'release':
      await releaseProject(project, { queueIfBlocked: true })
      return `Started release for ${project}`
    case 'review':
      await reviewProject(project)
      return `Started review for ${project}`
    case 'merge': {
      if (action.prNumber == null) throw new Error('Missing PR number')
      await mergePR(project, action.prNumber)
      // A red merge signal is a manual-merge HITL: the pipeline stalled on this
      // decision, so merging also resumes automation ("ship & continue"). A green
      // ready-to-merge on a healthy project must NOT touch pause state.
      if (item.severity === 'red') {
        try {
          await resumeProject(project)
          return `Merged PR #${action.prNumber} in ${project} — automation resumed`
        } catch {
          return `Merged PR #${action.prNumber} in ${project} (resume manually)`
        }
      }
      return `Merged PR #${action.prNumber} in ${project}`
    }
    case 'resolve-conflicts':
      if (action.prNumber == null) throw new Error('Missing PR number')
      await resolveConflicts(project, action.prNumber)
      return `Resolving conflicts on PR #${action.prNumber} in ${project} — rebasing & re-driving the merge`
    case 'retry-automation':
      await retryAutomationQueue(project)
      return `Retried automation queue for ${project}`
    case 'resume':
      await resumeProject(project)
      return `Resumed ${project}`
    default:
      throw new Error(`Unsupported signal action: ${action.kind}`)
  }
}

async function dispatchRecommendation(item: AttentionItem, action: AttentionAction): Promise<string> {
  const project = item.project
  const recId = action.recommendationId
  const agentId = item.agent?.id ?? null
  const agentName = item.agent?.name ?? 'the agent'
  const needsAgent = (): string => {
    if (!agentId) throw new Error('Recommendation is missing an agent')
    return agentId
  }
  switch (action.kind) {
    case 'dismiss':
      if (!recId) throw new Error('Missing recommendation id')
      await updateRecommendation(project, recId, 'dismissed')
      return `Dismissed recommendation in ${project}`
    case 'apply':
      if (!recId) throw new Error('Missing recommendation id')
      await applyRecommendationById(project, recId)
      return `Applied recommendation in ${project}`
    case 'run-now':
      await runAgent(needsAgent(), '')
      return `Triggered a run of ${agentName} in ${project}`
    case 'investigate':
      await runAgent(needsAgent(), INVESTIGATE_PROMPT, { readOnly: true })
      return `Started a read-only investigation run of ${agentName} in ${project}`
    case 'decrease-rate': {
      const schedule = action.payloadArg
      if (!schedule) throw new Error('Missing target schedule')
      await updateAgent(needsAgent(), { schedule })
      return `Set ${agentName} in ${project} to run every ${schedule}`
    }
    case 'stop-boosting':
      await updateAgent(needsAgent(), { boostable: false })
      return `Stopped boost runs for ${agentName} in ${project}`
    case 'disable': {
      const id = needsAgent()
      if (typeof window !== 'undefined' && !window.confirm(`Disable ${agentName} in ${project}? It will no longer run on its schedule.`)) {
        throw new Error('Cancelled')
      }
      await updateAgent(id, { enabled: false })
      // A disabled agent will never run again, so its "isn't producing changes"
      // recommendation can never auto-resolve (that only fires on a later
      // productive run). Dismiss it here so disabling from the card actually
      // clears the card instead of leaving stale advice for a stopped agent.
      if (recId) {
        try {
          await updateRecommendation(project, recId, 'dismissed')
        } catch {
          /* best effort — the agent is disabled regardless */
        }
      }
      return `Disabled ${agentName} in ${project} — recommendation cleared`
    }
    default:
      throw new Error(`Unsupported recommendation action: ${action.kind}`)
  }
}

/**
 * Route an AttentionItem's action to its existing per-project endpoint. Returns
 * a human-readable success message for the toast, or throws for the error toast.
 * Link-style actions (view-logs / improve-prompt / edit-agent) navigate in the
 * row and never reach here.
 */
export async function dispatchAttentionAction(item: AttentionItem, action: AttentionAction): Promise<string> {
  return item.source === 'signal' ? dispatchSignal(item, action) : dispatchRecommendation(item, action)
}
