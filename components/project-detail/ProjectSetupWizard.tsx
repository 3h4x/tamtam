'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  fetchProjectConfig,
  fetchProjectSetup,
  testProject,
  updateProjectConfig,
  updateProjectSetup,
  type ProjectConfig,
  type ProjectSetupStatus,
  type ProjectSetupStep,
} from '@/lib/client-api'
import { buildProjectPath, buildProjectTerminalPath } from '@/lib/client/project-routes'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

const STEPS: Array<{ id: ProjectSetupStep; label: string }> = [
  { id: 'detect', label: 'Detect' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'automation', label: 'Automation' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'file_config', label: 'File config' },
  { id: 'smoke_test', label: 'Smoke test' },
]

type SmokeState =
  | { status: 'idle' }
  | { status: 'running'; jobId: string }
  | { status: 'done'; jobId: string; exitCode: number | null }
  | { status: 'error'; message: string }

export function ProjectSetupWizard() {
  const params = useParams<{ name: string }>()
  const projectName = params.name
  const router = useRouter()
  const [setup, setSetup] = useState<ProjectSetupStatus | null>(null)
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingStep, setSavingStep] = useState<ProjectSetupStep | 'finish' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testCommand, setTestCommand] = useState('')
  const [releaseAfterRun, setReleaseAfterRun] = useState(false)
  const [autoCommit, setAutoCommit] = useState(false)
  const [autoPush, setAutoPush] = useState(false)
  const [autoMerge, setAutoMerge] = useState(false)
  const [writeFileConfig, setWriteFileConfig] = useState(false)
  const [safeUsers, setSafeUsers] = useState('')
  const [smoke, setSmoke] = useState<SmokeState>({ status: 'idle' })

  const completedCount = useMemo(() => {
    const state = setup?.setup_state ?? {}
    return STEPS.filter((step) => state[step.id] === 'completed' || state[step.id] === 'skipped').length
  }, [setup])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([fetchProjectSetup(projectName), fetchProjectConfig(projectName)])
      .then(([setupData, configData]) => {
        if (!active) return
        setSetup(setupData)
        setConfig(configData)
        setTestCommand(configData.test_command || setupData.detection.test_command || '')
        setReleaseAfterRun(!!configData.release_after_run)
        setAutoCommit(!!configData.auto_commit_enabled)
        setAutoPush(!!configData.auto_push_enabled)
        setAutoMerge(!!configData.auto_pr_merge_enabled)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load setup')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [projectName])

  const reloadSetup = async () => {
    const data = await fetchProjectSetup(projectName)
    setSetup(data)
    return data
  }

  const markStep = async (step: ProjectSetupStep, status: 'completed' | 'skipped') => {
    setSavingStep(step)
    setError(null)
    try {
      const updated = await updateProjectSetup(projectName, { step, status })
      setSetup((prev) => prev ? { ...prev, setup_complete: updated.setup_complete, setup_state: updated.setup_state } : prev)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setup step')
    } finally {
      setSavingStep(null)
    }
  }

  const savePipeline = async () => {
    setSavingStep('pipeline')
    setError(null)
    try {
      await updateProjectConfig(projectName, {
        test_command: testCommand,
        release_after_run: releaseAfterRun,
      })
      await updateProjectSetup(projectName, { step: 'pipeline', status: 'completed' })
      setConfig(await fetchProjectConfig(projectName))
      await reloadSetup()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pipeline setup')
    } finally {
      setSavingStep(null)
    }
  }

  const saveAutomation = async () => {
    setSavingStep('automation')
    setError(null)
    try {
      await updateProjectConfig(projectName, {
        auto_commit_enabled: autoCommit,
        auto_push_enabled: autoPush,
        auto_pr_merge_enabled: autoMerge,
      })
      await updateProjectSetup(projectName, { step: 'automation', status: 'completed' })
      setConfig(await fetchProjectConfig(projectName))
      await reloadSetup()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save automation setup')
    } finally {
      setSavingStep(null)
    }
  }

  const saveFileConfig = async () => {
    setSavingStep('file_config')
    setError(null)
    try {
      if (writeFileConfig) {
        await updateProjectSetup(projectName, {
          write_file_config: true,
          test_command: testCommand,
          safe_users: safeUsers.split(',').map((u) => u.trim()).filter(Boolean),
        })
      } else {
        await updateProjectSetup(projectName, { step: 'file_config', status: 'skipped' })
      }
      await reloadSetup()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save file config setup')
    } finally {
      setSavingStep(null)
    }
  }

  const runSmokeTest = async () => {
    setSavingStep('smoke_test')
    setError(null)
    try {
      const result = await testProject(projectName)
      setSmoke({ status: 'running', jobId: result.job_id })
      await updateProjectSetup(projectName, { step: 'smoke_test', status: 'completed' })
      await reloadSetup()
    } catch (err) {
      setSmoke({ status: 'error', message: err instanceof Error ? err.message : 'Failed to start smoke test' })
    } finally {
      setSavingStep(null)
    }
  }

  useEffect(() => {
    if (smoke.status !== 'running') return
    let active = true
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(smoke.jobId)}`)
        if (!res.ok) return
        const job = await res.json() as { status?: string; exit_code?: number | null }
        if (!active || job.status === 'running') return
        setSmoke({ status: 'done', jobId: smoke.jobId, exitCode: job.exit_code ?? null })
      } catch {
        // Keep polling; the job detail may not be visible immediately.
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [smoke])

  const finish = async () => {
    setSavingStep('finish')
    setError(null)
    try {
      await updateProjectSetup(projectName, { setup_complete: true })
      router.push(buildProjectPath(projectName, 'config'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to finish setup')
    } finally {
      setSavingStep(null)
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-sm text-text-secondary">
        <Spinner shrink /> Loading setup…
      </div>
    )
  }

  if (!setup || !config) {
    return (
      <div className="p-6">
        <Button variant="link" onClick={() => router.push(buildProjectPath(projectName))}>&larr; Back to project</Button>
        <p className="mt-3 text-sm text-status-error">{error || 'Setup unavailable'}</p>
      </div>
    )
  }

  const stepState = setup.setup_state

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Button variant="link" className="mb-2 font-normal" onClick={() => router.push(buildProjectPath(projectName, 'config'))}>
            &larr; Back to config
          </Button>
          <h1 className="text-xl font-semibold text-text-primary" data-private>{projectName} setup</h1>
          <p className="text-sm text-text-secondary mt-1">{completedCount}/{STEPS.length} steps saved</p>
        </div>
        <Button variant="solid" onClick={finish} disabled={savingStep !== null}>
          {savingStep === 'finish' && <Spinner color="white" shrink />}
          Finish setup
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {STEPS.map((step) => {
          const status = stepState[step.id]
          return (
            <span
              key={step.id}
              className={`rounded-full border px-2 py-1 text-xs font-medium ${
                status === 'completed'
                  ? 'border-status-success/40 bg-status-success/10 text-status-success'
                  : status === 'skipped'
                    ? 'border-border bg-bg-secondary text-text-tertiary'
                    : 'border-border bg-bg-primary text-text-secondary'
              }`}
            >
              {step.label}{status ? `: ${status}` : ''}
            </span>
          )
        })}
      </div>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Detect</h2>
        </div>
        <div className="grid gap-2 px-4 py-3 text-sm md:grid-cols-2">
          <DetectionRow label="Test" value={setup.detection.test_command || 'none'} />
          <DetectionRow label="Default branch" value={setup.detection.default_branch || 'unknown'} />
          <DetectionRow label="GitHub" value={setup.detection.github_repo || setup.detection.github_remote || 'none'} />
          <DetectionRow label="gh auth" value={setup.detection.gh_auth.available ? 'available' : 'not available'} tone={setup.detection.gh_auth.available ? 'ok' : 'warn'} />
          <DetectionRow label="CI workflow" value={setup.detection.ci_workflow ? 'found' : 'not found'} tone={setup.detection.ci_workflow ? 'ok' : 'warn'} />
        </div>
        <StepActions step="detect" savingStep={savingStep} onComplete={markStep} />
      </section>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Pipeline</h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="setup-test-command">Test command</label>
            <Input id="setup-test-command" inputSize="compact" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder={setup.detection.test_command || 'pnpm test'} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox variant="native" className="mt-0.5" checked={releaseAfterRun} onChange={(e) => setReleaseAfterRun(e.target.checked)} />
            <span>
              <span className="font-medium text-text-primary">Release after runs</span>
              <span className="block text-xs text-text-tertiary">Terminal and agent runs hand off to the release pipeline when they finish.</span>
            </span>
          </label>
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
            Push behavior is decided at runtime from the active branch: default branch pushes directly; feature branches create or reuse a PR.
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="primary" disabled={savingStep !== null} onClick={savePipeline}>
            {savingStep === 'pipeline' && <Spinner shrink />}
            Save pipeline
          </Button>
          <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => markStep('pipeline', 'skipped')}>Skip</Button>
        </div>
      </section>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Automation</h2>
        </div>
        <div className="grid gap-3 px-4 py-3 md:grid-cols-3">
          <SetupToggle label="Auto commit" checked={autoCommit} onChange={setAutoCommit} description="Successful review can create a commit." />
          <SetupToggle label="Auto push" checked={autoPush} onChange={setAutoPush} description="Successful commit can push or open a PR." />
          <SetupToggle label="Auto PR merge" checked={autoMerge} onChange={setAutoMerge} description="Eligible PRs can merge after gates pass." />
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="primary" disabled={savingStep !== null} onClick={saveAutomation}>
            {savingStep === 'automation' && <Spinner shrink />}
            Save automation
          </Button>
          <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => markStep('automation', 'skipped')}>Skip</Button>
        </div>
      </section>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Notifications</h2>
        </div>
        <div className="px-4 py-3 text-sm text-text-secondary">
          Global webhook channels are managed in Settings. Per-project channels are not configured for this install.
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="secondary" onClick={() => router.push('/settings/notifications')}>Open settings</Button>
          <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => markStep('notifications', 'skipped')}>Skip</Button>
        </div>
      </section>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">File config</h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox variant="native" className="mt-0.5" checked={writeFileConfig} onChange={(e) => setWriteFileConfig(e.target.checked)} />
            <span>
              <span className="font-medium text-text-primary">Write .tamtam/config.yml</span>
              <span className="block text-xs text-text-tertiary">Stores team-shareable test command and safe GitHub users.</span>
            </span>
          </label>
          {writeFileConfig && (
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor="setup-safe-users">Safe GitHub users</label>
              <Input id="setup-safe-users" inputSize="compact" value={safeUsers} onChange={(e) => setSafeUsers(e.target.value)} placeholder="alice, bob" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="primary" disabled={savingStep !== null} onClick={saveFileConfig}>
            {savingStep === 'file_config' && <Spinner shrink />}
            Save file step
          </Button>
          <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => markStep('file_config', 'skipped')}>Skip</Button>
        </div>
      </section>

      <section className="rounded-md border border-border bg-bg-secondary">
        <div className="border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-text-primary">Smoke test</h2>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm text-text-secondary">
          <p>Runs one test job using the configured command.</p>
          {smoke.status === 'running' && (
            <p className="text-status-info">Running job <span className="font-mono">{smoke.jobId}</span></p>
          )}
          {smoke.status === 'done' && (
            <p className={smoke.exitCode === 0 ? 'text-status-success' : 'text-status-error'}>
              Finished with exit code <span className="font-mono">{smoke.exitCode ?? 'unknown'}</span>
            </p>
          )}
          {smoke.status === 'error' && <p className="text-status-error">{smoke.message}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="primary" disabled={savingStep !== null} onClick={runSmokeTest}>
            {savingStep === 'smoke_test' && <Spinner shrink />}
            Run test
          </Button>
          {smoke.status === 'running' && (
            <Button size="sm" variant="secondary" onClick={() => router.push(buildProjectTerminalPath(projectName, { jobId: smoke.jobId }))}>Open job</Button>
          )}
          <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => markStep('smoke_test', 'skipped')}>Skip</Button>
        </div>
      </section>
    </div>
  )
}

function DetectionRow({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' }) {
  const toneClass = tone === 'ok' ? 'text-status-success' : tone === 'warn' ? 'text-status-warning' : 'text-text-primary'
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-primary px-3 py-2">
      <span className="text-xs font-medium text-text-tertiary">{label}</span>
      <span className={`truncate text-xs font-mono ${toneClass}`} title={value}>{value}</span>
    </div>
  )
}

function StepActions({
  step,
  savingStep,
  onComplete,
}: {
  step: ProjectSetupStep
  savingStep: ProjectSetupStep | 'finish' | null
  onComplete: (step: ProjectSetupStep, status: 'completed' | 'skipped') => void
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border px-4 py-3">
      <Button size="sm" variant="primary" disabled={savingStep !== null} onClick={() => onComplete(step, 'completed')}>
        {savingStep === step && <Spinner shrink />}
        Mark done
      </Button>
      <Button size="sm" variant="ghost" disabled={savingStep !== null} onClick={() => onComplete(step, 'skipped')}>Skip</Button>
    </div>
  )
}

function SetupToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border bg-bg-primary px-3 py-2 text-sm">
      <Checkbox variant="native" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        <span className="block text-xs text-text-tertiary">{description}</span>
      </span>
    </label>
  )
}
