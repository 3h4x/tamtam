'use client'

import { useEffect, useMemo, useState } from 'react'
import { useToast } from '@/components/Toast'
import { Button } from '@/components/ui/Button'

interface Recipe {
  id: string
  title: string
  blurb: string
  curl: (base: string) => string
  notes?: string
}

const RECIPES: Recipe[] = [
  {
    id: 'health',
    title: 'Health check',
    blurb: 'Liveness probe. Use deep=1 for dependency status.',
    curl: (base) => `curl -s ${base}/api/health\ncurl -s '${base}/api/health?deep=1'`,
  },
  {
    id: 'projects',
    title: 'List projects',
    blurb: 'All tracked projects with metadata.',
    curl: (base) => `curl -s ${base}/api/projects`,
  },
  {
    id: 'runs-recent',
    title: 'Recent runs',
    blurb: 'Newest first, paged. Filter by project/kind/status.',
    curl: (base) =>
      `curl -s '${base}/api/jobs?limit=20'\ncurl -s '${base}/api/jobs?project=<project>&status=running'\ncurl -s '${base}/api/jobs?kind=agent:<agent-name>&limit=5'`,
  },
  {
    id: 'run-detail',
    title: 'Run detail + logs',
    blurb: 'Full record with parsed log; or fetch raw log file.',
    curl: (base) => `curl -s ${base}/api/jobs/<jobId>\ncurl -s ${base}/api/jobs/<jobId>/logs`,
  },
  {
    id: 'run-stream',
    title: 'Stream a live run (SSE)',
    blurb: 'Server-sent events of parsed text deltas. Raw=1 for raw NDJSON lines.',
    curl: (base) => `curl -N ${base}/api/streaming/<jobId>\ncurl -N '${base}/api/streaming/<jobId>?raw=1'`,
  },
  {
    id: 'list-agents',
    title: 'List agents (with schedule telemetry)',
    blurb: 'fields=summary returns slim rows + live cron state.',
    curl: (base) =>
      `curl -s '${base}/api/agents?fields=summary'\ncurl -s '${base}/api/agents?project=<project>'\ncurl -s '${base}/api/agents?name=<agent-name>&project=<project>'`,
  },
  {
    id: 'create-agent',
    title: 'Create an agent',
    blurb: 'kind=user only. provider null = any enabled provider.',
    curl: (base) => `curl -s -X POST ${base}/api/agents \\
  -H 'content-type: application/json' \\
  -d '{
    "project": "<project>",
    "name": "<agent-name>",
    "prompt": "Run the security audit and report findings.",
    "model": "sonnet",
    "provider": null,
    "skillIds": [],
    "docPaths": ["docs/SECURITY.md"],
    "schedule": "24h",
    "enabled": true
  }'`,
    notes:
      'Schedule format: <N>m|h|d, e.g. 15m, 1h, 4h, 24h, 7d. Names are project-scoped, case-insensitive unique, no slashes/backslashes/control chars.',
  },
  {
    id: 'patch-agent',
    title: 'Update an agent',
    blurb: 'PATCH any writable field. null/empty string clears optional fields.',
    curl: (base) => `curl -s -X PATCH ${base}/api/agents/<agentId> \\
  -H 'content-type: application/json' \\
  -d '{"schedule":"4h","enabled":true}'

# Without UUID — lookup by project+name (and rename via currentName):
curl -s -X PATCH ${base}/api/agents/by-name \\
  -H 'content-type: application/json' \\
  -d '{"project":"<project>","currentName":"<agent-name>","name":"<agent-name>","schedule":"12h"}'`,
  },
  {
    id: 'run-agent',
    title: 'Trigger an agent run',
    blurb: 'Returns immediately with job_id; poll /api/jobs/<id> for status.',
    curl: (base) => `curl -s -X POST ${base}/api/agents/<agentId>/run \\
  -H 'content-type: application/json' \\
  -d '{"prompt":"Optional extra instruction for this run","readOnly":false}'`,
    notes:
      '202 queued = another agent on the same project is running. 409 = same-agent duplicate, project busy/paused, or release lock. readOnly:true bypasses local-worktree serialization but still respects release locks and quotas. System agents (kind=system) ignore prompt.',
  },
  {
    id: 'scheduler-health',
    title: 'Scheduler health',
    blurb: 'Verify cron rows exist for all enabled scheduled agents. POST reinstalls missing ones.',
    curl: (base) =>
      `curl -s ${base}/api/agents/scheduler-health\ncurl -s -X POST ${base}/api/agents/scheduler-health`,
  },
  {
    id: 'pause-project',
    title: 'Pause / archive a project',
    blurb: 'paused=true blocks scheduled fires + releases (manual terminal still works). archived hides from list.',
    curl: (base) => `curl -s -X PATCH ${base}/api/projects/by-project/<project> \\
  -H 'content-type: application/json' \\
  -d '{"paused": true}'`,
  },
  {
    id: 'release',
    title: 'Trigger release pipeline',
    blurb: 'test → review → fix → commit → push → mark-dod → pr-wait → soak. Honors release lock.',
    curl: (base) => `curl -s -X POST ${base}/api/projects/by-project/<project>/release`,
  },
  {
    id: 'pause-global',
    title: 'Global pause / resume',
    blurb: 'Pause all scheduler activity and release pipelines. Manual terminal runs bypass this.',
    curl: (base) => `curl -s -X PATCH ${base}/api/settings \\
  -H 'content-type: application/json' \\
  -d '{"jobs_paused": true}'

# resume
curl -s -X PATCH ${base}/api/settings \\
  -H 'content-type: application/json' \\
  -d '{"jobs_paused": false}'`,
  },
  {
    id: 'queue',
    title: 'Inspect / drain automation queue',
    blurb: 'Deferred releases and queued agent runs. retry runs the same ordered drain as boot recovery.',
    curl: (base) =>
      `curl -s '${base}/api/automation-queue?project=<project>'\ncurl -s -X POST ${base}/api/automation-queue/retry -H 'content-type: application/json' -d '{"project":"<project>"}'`,
  },
  {
    id: 'quota',
    title: 'Provider quota + pace',
    blurb: 'Quota snapshot with pace math. POST force-clears the cache and re-fetches.',
    curl: (base) =>
      `curl -s ${base}/api/usage/quota\ncurl -s '${base}/api/usage/quota?provider=claude'\ncurl -s -X POST ${base}/api/usage/quota`,
    notes:
      'Response carries pace (this provider’s 5h/7d fair-share margin: paceMarginPct >0 = under pace, <0 = over, plus projectedPct at reset) and globalPace (the tightest provider+window across enabled providers, with bindingProvider/bindingWindow). Snapshots are persisted to the DB, so a rate-limited or just-restarted provider still appears (marked stale) instead of dropping out of pace.',
  },
  {
    id: 'bridge',
    title: 'Fleet bridge (pace + shipping status)',
    blurb: 'One compact rollup: global pace, per-provider pace, and per-project shipping state for every project that has enabled agents.',
    curl: (base) => `curl -s ${base}/api/stats/bridge`,
    notes:
      'projects[] is generic — one row per project with ≥1 enabled non-system agent. Each carries status (releasing | paused | attention | shipping | active | idle), releaseRunning, lastPushAt/lastPushOk, lastReleaseAt/lastReleaseOk, lastAgentAt; summary rolls up the counts. Use it as a single probe for “is the fleet pacing and shipping”.',
  },
  {
    id: 'recommendations',
    title: 'Recommendations',
    blurb: 'Cross-project open recommendations. Apply auto-applicable ones in place.',
    curl: (base) =>
      `curl -s ${base}/api/recommendations\ncurl -s '${base}/api/projects/by-project/<project>/recommendations'\ncurl -s -X POST ${base}/api/projects/by-project/<project>/recommendations/apply \\
  -H 'content-type: application/json' -d '{"id":"<recId>"}'`,
  },
]

interface ApiGroup {
  title: string
  rows: { method: string; path: string; desc: string }[]
}

const API_REFERENCE: ApiGroup[] = [
  {
    title: 'Health & telemetry',
    rows: [
      { method: 'GET', path: '/api/health', desc: 'Liveness. ?deep=1 for dependency checks.' },
      { method: 'GET', path: '/api/monitoring', desc: 'Prometheus/Loki + notification + retention status.' },
      { method: 'GET', path: '/api/stats/usage', desc: 'Token usage. ?window=24h|7d|30d|all.' },
      { method: 'GET', path: '/api/stats/pipeline', desc: 'Pipeline health, verdicts, step durations.' },
      { method: 'GET', path: '/api/stats/bridge', desc: 'Fleet rollup: pace + per-project shipping status.' },
      { method: 'GET', path: '/api/usage/quota', desc: 'Provider quota snapshot + pace (per-CLI + global).' },
    ],
  },
  {
    title: 'Runs (jobs)',
    rows: [
      { method: 'GET', path: '/api/jobs', desc: 'Paged runs. project, kind, status, limit, offset.' },
      { method: 'GET', path: '/api/jobs/counts', desc: 'Aggregate totals without row payloads.' },
      { method: 'GET', path: '/api/jobs/[jobId]', desc: 'Full run + display log.' },
      { method: 'DELETE', path: '/api/jobs/[jobId]', desc: 'Cancel a run.' },
      { method: 'GET', path: '/api/jobs/[jobId]/logs', desc: 'Raw log file.' },
      { method: 'GET', path: '/api/jobs/[jobId]/resources', desc: 'CPU/RSS samples.' },
      { method: 'POST', path: '/api/jobs/[jobId]/rerun', desc: 'Re-run a finished job.' },
      { method: 'POST', path: '/api/jobs/[jobId]/continue', desc: 'Resume a finished session within 30 min.' },
      { method: 'POST', path: '/api/jobs/[jobId]/fix', desc: 'Spawn AI fix run for a failed job.' },
      { method: 'GET', path: '/api/streaming/[jobId]', desc: 'SSE text deltas. ?raw=1 for NDJSON.' },
    ],
  },
  {
    title: 'Agents',
    rows: [
      { method: 'GET', path: '/api/agents', desc: 'List agents. fields=summary, project, name filters.' },
      { method: 'POST', path: '/api/agents', desc: 'Create user agent.' },
      { method: 'GET', path: '/api/agents/[agentId]', desc: 'Agent detail.' },
      { method: 'PATCH', path: '/api/agents/[agentId]', desc: 'Update agent (system: schedule/enabled only).' },
      { method: 'DELETE', path: '/api/agents/[agentId]', desc: 'Remove agent.' },
      { method: 'PATCH', path: '/api/agents/by-name', desc: 'Update by project+name; rename via currentName.' },
      { method: 'POST', path: '/api/agents/[agentId]/run', desc: 'Trigger run. body: { prompt, readOnly? }.' },
      { method: 'GET', path: '/api/agents/stats', desc: 'Per-agent aggregates. ?project=<name> required.' },
      { method: 'POST', path: '/api/agents/improve-prompt', desc: 'Rewrite draft prompt with project context.' },
      { method: 'GET', path: '/api/agents/scheduler-health', desc: 'Verify cron rows exist for enabled agents.' },
      { method: 'POST', path: '/api/agents/scheduler-health', desc: 'Reinstall missing cron rows.' },
      { method: 'GET', path: '/api/agent-catalog', desc: 'Built-in agent templates.' },
    ],
  },
  {
    title: 'Projects',
    rows: [
      { method: 'GET', path: '/api/projects', desc: 'All projects.' },
      { method: 'GET', path: '/api/projects/runtime', desc: 'Per-project running-state snapshot.' },
      { method: 'PATCH', path: '/api/projects/by-project/[name]', desc: 'Set archived and/or paused.' },
      { method: 'GET', path: '/api/projects/by-project/[name]/changes', desc: 'Uncommitted changes summary.' },
      { method: 'GET', path: '/api/projects/by-project/[name]/branch', desc: 'Current + default branch.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/run', desc: 'Manual Claude run on project.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/review', desc: 'Start AI code review.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/release', desc: 'Trigger release pipeline.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/release/abort', desc: 'Abort active release.' },
      { method: 'GET', path: '/api/projects/by-project/[name]/release/[releaseId]', desc: 'Release detail.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/push', desc: 'Push current branch.' },
      { method: 'POST', path: '/api/projects/by-project/[name]/create-pr', desc: 'Push + create PR.' },
      { method: 'GET', path: '/api/projects/by-project/[name]/issues', desc: 'GitHub PRs and issues.' },
    ],
  },
  {
    title: 'Settings, queue, recommendations',
    rows: [
      { method: 'GET', path: '/api/settings', desc: 'All settings.' },
      { method: 'PATCH', path: '/api/settings', desc: 'Update settings (incl. jobs_paused).' },
      { method: 'POST', path: '/api/settings/backup', desc: 'pg_dump backup.' },
      { method: 'GET', path: '/api/automation-queue', desc: 'Pending releases + queued agent runs.' },
      { method: 'POST', path: '/api/automation-queue/retry', desc: 'Drain a project queue.' },
      { method: 'POST', path: '/api/automation-queue/cancel', desc: 'Cancel a queued item.' },
      { method: 'GET', path: '/api/recommendations', desc: 'Open recommendations across projects.' },
      { method: 'GET', path: '/api/recommendations/summary', desc: 'Counts for header polling.' },
    ],
  },
]

const BEHAVIORS: { title: string; body: string }[] = [
  {
    title: 'Per-project serialization',
    body:
      'Only one agent runs at a time per project. Concurrent calls return 202 (queued) with code=pending_release / pipeline_lock. Same-agent duplicates return 409 (already_running). A different non-agent job blocks with 409 (project_busy).',
  },
  {
    title: 'Pause gates',
    body:
      'Global PATCH /api/settings { jobs_paused: true } stops scheduled agents and release pipelines; manual terminal runs and manual agent runs bypass it. Per-project paused=true also blocks scheduled fires and release starts.',
  },
  {
    title: 'Budget gates',
    body:
      'The provider chooser routes around exhausted quota-backed CLIs; if every enabled quota-backed provider is over budget_block_at_pct, job starts return 429. Check /api/usage/quota before scheduling expensive work.',
  },
  {
    title: 'Release locks',
    body:
      'A release pipeline holds an exclusive project lock for its duration. Agent runs queue with code=pipeline_lock until the lock releases.',
  },
  {
    title: 'Release-first workflow',
    body:
      'Release is the priority and runs after a productive agent run. A scheduled agent fire is skipped (then retried shortly) while the project still has a release pipeline running, uncommitted changes, or unpushed commits — so work never piles up un-shipped. The next run only starts once the tree is clean and the previous release has landed. Manual runs still bypass this.',
  },
  {
    title: 'Pace signals',
    body:
      'paceMarginPct on /api/usage/quota answers “how much room is left to fair-share pace” per window (>0 under, <0 over); globalPace names the tightest provider+window across the fleet. /api/stats/bridge folds that together with per-project shipping state. Quota snapshots persist to the DB, so a rate-limited provider stays visible (stale) instead of disappearing from pace.',
  },
  {
    title: 'Schedule format',
    body:
      'Agent schedules are intervals, not cron: 15m, 1h, 4h, 24h, 7d. Valid units are m / h / d with a positive integer.',
  },
  {
    title: 'Stream lifecycle',
    body:
      '/api/streaming/[jobId] is SSE — keep the connection open until the server closes it. Reconnect by polling /api/jobs/[jobId] for the finished status, then fetch /api/jobs/[jobId] for the parsed log.',
  },
  {
    title: 'Idempotent agent identity',
    body:
      'Agent names are case-insensitive unique per project and map to .tamtam/agents/<name>.md for user agents. PATCH /api/agents/by-name lets a remote operator update agents without remembering UUIDs.',
  },
]

function useOrigin(): string {
  const [origin, setOrigin] = useState('http://127.0.0.1:1337')
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      setOrigin(window.location.origin)
    }
  }, [])
  return origin
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch {
          toast('Copy failed', 'error')
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="font-mono text-xs leading-relaxed bg-bg-tertiary border border-border rounded-md p-3 overflow-x-auto text-text-primary whitespace-pre">
      {children}
    </pre>
  )
}

function buildGuideMarkdown(origin: string): string {
  const lines: string[] = []
  lines.push('# TamTam — Remote Operator Guide')
  lines.push('')
  lines.push(`Base URL: ${origin}/api`)
  lines.push('Auth: none (self-hosted; bind interface accordingly).')
  lines.push('')
  lines.push('## What TamTam is')
  lines.push('')
  lines.push('TamTam is the **orchestrator**, not a project. It sits above every tracked repo and runs work on them.')
  lines.push('')
  lines.push('Three layers, with cleanly split responsibilities:')
  lines.push('')
  lines.push('- **TamTam** — the runner. Owns scheduling, the release pipeline, jobs/runs, agents, the agent + skill library, settings, retrieval indexes, notifications.')
  lines.push('- **Projects** — tracked repositories. Each project owns its own code, branch state, CLAUDE.md conventions, GitHub issues/PRs. TamTam reads them and runs work *against* them, but never owns their domain.')
  lines.push('- **Runs (jobs)** — every unit of work TamTam executes. Reviews, releases, agent invocations, fix-ups, terminal calls — all are runs. Runs live at the TamTam level (you query them via `/api/jobs`, not `/api/projects/<name>/jobs`) because TamTam is what scheduled and executed them.')
  lines.push('')
  lines.push('Mental shortcut for choosing an endpoint:')
  lines.push('')
  lines.push('- Need to inspect a *repository\'s* state (branch, changes, issues, config, docs) → `/api/projects/by-project/<name>/…`')
  lines.push('- Need to inspect or operate on *something TamTam did* (runs, pipelines, agents, settings) → top-level `/api/*` routes')
  lines.push('')
  lines.push('## Common tasks')
  for (const r of RECIPES) {
    lines.push('')
    lines.push(`### ${r.title}`)
    lines.push(r.blurb)
    lines.push('')
    lines.push('```bash')
    lines.push(r.curl(origin))
    lines.push('```')
    if (r.notes) {
      lines.push('')
      lines.push(`Notes: ${r.notes}`)
    }
  }
  lines.push('')
  lines.push('## Behavior')
  for (const b of BEHAVIORS) {
    lines.push('')
    lines.push(`### ${b.title}`)
    lines.push(b.body)
  }
  lines.push('')
  lines.push('## API reference')
  for (const g of API_REFERENCE) {
    lines.push('')
    lines.push(`### ${g.title}`)
    for (const row of g.rows) {
      lines.push(`- \`${row.method} ${row.path}\` — ${row.desc}`)
    }
  }
  return lines.join('\n')
}

export function AgentGuidePage() {
  const origin = useOrigin()
  const apiBase = `${origin}/api`
  const fullGuide = useMemo(() => buildGuideMarkdown(origin), [origin])

  return (
    <div className="flex flex-col gap-6 pb-24 max-w-5xl">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-text-primary">Agent — Remote Operator Guide</h1>
        <p className="text-sm text-text-secondary">
          Drop-in instructions for a remote Claude (or any HTTP client) that needs to manage TamTam:
          inspect recent runs, trigger and schedule agents, pause/resume work, and check pipeline health.
        </p>
      </header>

      <section className="border border-border rounded-lg bg-bg-secondary">
        <div className="px-4 py-3 bg-bg-tertiary border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">What TamTam is</h2>
        </div>
        <div className="p-4 flex flex-col gap-3 text-sm text-text-secondary">
          <p>
            TamTam is the <strong className="text-text-primary">orchestrator</strong>, not a project. It sits above every
            tracked repo and runs work on them.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="border border-border rounded-md bg-bg-tertiary p-3">
              <div className="text-xs font-semibold text-accent uppercase tracking-wider">TamTam</div>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                The runner. Owns scheduling, the release pipeline, jobs/runs, agents, the agent + skill library,
                settings, retrieval indexes, notifications.
              </p>
            </div>
            <div className="border border-border rounded-md bg-bg-tertiary p-3">
              <div className="text-xs font-semibold text-accent uppercase tracking-wider">Projects</div>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                Tracked repositories. Each project owns its own code, branch state, CLAUDE.md conventions,
                GitHub issues/PRs. TamTam reads them and runs work <em>against</em> them, but never owns their domain.
              </p>
            </div>
            <div className="border border-border rounded-md bg-bg-tertiary p-3">
              <div className="text-xs font-semibold text-accent uppercase tracking-wider">Runs (jobs)</div>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                Every unit of work TamTam executes — reviews, releases, agent invocations, fix-ups, terminal
                calls. Runs live at the TamTam level (querying <code className="font-mono">/api/jobs</code>, not{' '}
                <code className="font-mono">/api/projects/&lt;name&gt;/jobs</code>) because TamTam is what scheduled
                and executed them.
              </p>
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
              Choosing an endpoint
            </div>
            <ul className="text-xs text-text-secondary space-y-1 leading-relaxed">
              <li>
                Inspecting a <strong className="text-text-primary">repository&apos;s</strong> state (branch,
                changes, issues, config, docs) →{' '}
                <code className="font-mono">/api/projects/by-project/&lt;name&gt;/…</code>
              </li>
              <li>
                Inspecting or operating on <strong className="text-text-primary">something TamTam did</strong>{' '}
                (runs, pipelines, agents, settings) → top-level <code className="font-mono">/api/*</code> routes
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="border border-border rounded-lg bg-bg-secondary">
        <div className="px-4 py-3 bg-bg-tertiary border-b border-border flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">Base URL</h2>
          <CopyButton text={apiBase} label="Copy URL" />
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="font-mono text-sm text-accent">{apiBase}</div>
          <p className="text-sm text-text-secondary">
            All routes below are relative to this base. TamTam ships without API auth — it is intended
            to run on a trusted interface (localhost, tailnet, internal LAN). Bind the listener
            accordingly and put it behind a reverse proxy or firewall if you expose it.
          </p>
          <p className="text-xs text-text-tertiary">
            JSON in, JSON out unless the path documents otherwise. <code className="font-mono">/api/streaming/[jobId]</code> is SSE.
            All POST/PATCH bodies are <code className="font-mono">application/json</code>.
          </p>
        </div>
      </section>

      <section className="border border-border rounded-lg bg-bg-secondary">
        <div className="px-4 py-3 bg-bg-tertiary border-b border-border flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-text-primary">Copy entire guide as Markdown</h2>
          <CopyButton text={fullGuide} label="Copy guide" />
        </div>
        <div className="p-4">
          <p className="text-sm text-text-secondary">
            Paste this into a system prompt or attach as a doc so a remote Claude has a self-contained
            operating manual. Regenerated live from this page so the base URL matches your environment.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">Common tasks</h2>
        <div className="grid gap-3">
          {RECIPES.map((r) => {
            const snippet = r.curl(origin)
            return (
              <article key={r.id} className="border border-border rounded-md bg-bg-secondary">
                <header className="flex items-start justify-between gap-3 px-4 py-2.5 bg-bg-tertiary border-b border-border">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">{r.title}</h3>
                    <p className="text-xs text-text-secondary mt-0.5">{r.blurb}</p>
                  </div>
                  <CopyButton text={snippet} />
                </header>
                <div className="p-3">
                  <CodeBlock>{snippet}</CodeBlock>
                  {r.notes && (
                    <p className="text-xs text-text-tertiary mt-2">{r.notes}</p>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">Behavior to know before automating</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {BEHAVIORS.map((b) => (
            <div key={b.title} className="border border-border rounded-md bg-bg-secondary p-3">
              <h3 className="text-sm font-semibold text-text-primary">{b.title}</h3>
              <p className="text-xs text-text-secondary mt-1 leading-relaxed">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">API reference</h2>
        <p className="text-xs text-text-tertiary">
          Headline routes only. For exhaustive documentation see <code className="font-mono">docs/API.md</code> in the repo.
        </p>
        <div className="flex flex-col gap-4">
          {API_REFERENCE.map((g) => (
            <div key={g.title} className="border border-border rounded-md bg-bg-secondary overflow-hidden">
              <div className="px-4 py-2 bg-bg-tertiary border-b border-border">
                <h3 className="text-sm font-semibold text-text-primary">{g.title}</h3>
              </div>
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-text-tertiary uppercase tracking-wider">
                    <th className="text-left px-4 py-1.5 w-16 font-medium">Method</th>
                    <th className="text-left px-4 py-1.5 font-medium">Path</th>
                    <th className="text-left px-4 py-1.5 font-medium font-sans normal-case tracking-normal">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((row) => (
                    <tr key={`${row.method} ${row.path}`} className="border-t border-border">
                      <td className="px-4 py-1.5 text-accent">{row.method}</td>
                      <td className="px-4 py-1.5 text-text-primary">{row.path}</td>
                      <td className="px-4 py-1.5 font-sans text-text-secondary">{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      <section className="border border-border rounded-lg bg-bg-secondary">
        <div className="px-4 py-3 bg-bg-tertiary border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">MCP integration</h2>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            This repo ships a generic MCP-to-HTTP shim at{' '}
            <code className="font-mono">.tamtam/mcp-http-tools.yaml</code> exposing common TamTam routes
            (<code className="font-mono">tamtam_api_get</code>, <code className="font-mono">tamtam_job</code>,{' '}
            <code className="font-mono">tamtam_health</code>, …) as MCP tools. A remote Claude with the
            <code className="font-mono"> mcp-http-tools</code> server attached can call them without
            crafting raw HTTP.
          </p>
          <CodeBlock>{`# minimal client config
{
  "mcpServers": {
    "tamtam": {
      "command": "npx",
      "args": ["-y", "mcp-http-tools", ".tamtam/mcp-http-tools.yaml"]
    }
  }
}`}</CodeBlock>
        </div>
      </section>
    </div>
  )
}
