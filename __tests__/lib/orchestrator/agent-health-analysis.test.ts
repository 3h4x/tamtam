import { beforeEach, describe, expect, it, vi } from 'vitest'

const { upsertRecommendationMock, resolveRecommendationIfOpenMock, dbSelectMock } = vi.hoisted(() => ({
  upsertRecommendationMock: vi.fn(),
  resolveRecommendationIfOpenMock: vi.fn().mockResolvedValue(null),
  dbSelectMock: vi.fn(),
}))

vi.mock('@/lib/recommendations/recommendations', () => ({
  upsertRecommendation: upsertRecommendationMock,
  resolveRecommendationIfOpen: resolveRecommendationIfOpenMock,
}))

// Mock DB: return fake job rows via the Drizzle chain
vi.mock('@/lib/db', () => {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(dbSelectMock())),
  }
  return {
    db: { select: vi.fn(() => chain) },
    schema: {
      jobs: {
        id: 'id',
        project: 'project',
        kind: 'kind',
        finishedAt: 'finishedAt',
        contextMeta: 'contextMeta',
        startedAt: 'startedAt',
        workSummary: 'workSummary',
        runScore: 'runScore',
        modifiedFiles: 'modifiedFiles',
        linesAdded: 'linesAdded',
        linesRemoved: 'linesRemoved',
      },
    },
  }
})

import { analyzeAgentHealth, type HealthCandidate } from '@/lib/orchestrator/agent-health-analysis'

const candidateA: HealthCandidate = { id: 'agent-001', name: 'improve', project: 'alpha' }

function mockRun(overrides: Partial<{
  id: string;
  workSummary: string | null;
  runScore: number | null;
  modifiedFiles: string;
  startedAt: number;
  contextMeta: string;
}> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    kind: 'agent:improve',
    workSummary: overrides.workSummary ?? 'Refactored auth module and added tests.',
    runScore: overrides.runScore ?? 80,
    modifiedFiles: overrides.modifiedFiles ?? JSON.stringify([{ path: 'a.ts', confidence: 'high' }]),
    linesAdded: 20,
    linesRemoved: 5,
    startedAt: overrides.startedAt ?? 1000000,
    contextMeta: overrides.contextMeta ?? JSON.stringify({ agent: { id: 'agent-001', name: 'improve', triggeredBy: 'schedule' } }),
  }
}

function runPrintReturning(verdict: object | null): (prompt: string) => Promise<string | null> {
  return vi.fn(async () => (verdict == null ? null : JSON.stringify(verdict)))
}

describe('analyzeAgentHealth', () => {
  beforeEach(() => {
    upsertRecommendationMock.mockReset()
    resolveRecommendationIfOpenMock.mockReset()
    resolveRecommendationIfOpenMock.mockResolvedValue(null)
    dbSelectMock.mockReset()
    dbSelectMock.mockReturnValue([mockRun(), mockRun(), mockRun()])
  })

  it('does not call the runner when no recent runs found', async () => {
    dbSelectMock.mockReturnValue([])
    const runPrint = vi.fn(async () => JSON.stringify({ concern: true, concernType: 'loop', severity: 'high', summary: 's', recommendation: 'r' }))
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(runPrint).not.toHaveBeenCalled()
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  it('passes a prompt containing the agent name and run summaries to the runner', async () => {
    const runPrint = vi.fn(async (_prompt: string) => JSON.stringify({ concern: false, concernType: 'none', severity: 'low', summary: 'ok', recommendation: null }))
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(runPrint).toHaveBeenCalledOnce()
    const prompt = runPrint.mock.calls[0][0]
    expect(prompt).toContain('improve')
    expect(prompt).toContain('Refactored auth module')
    expect(prompt).toContain('score: 80/100')
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 1000000 }])
  })

  it('excludes manual runs before building the prompt', async () => {
    dbSelectMock.mockReturnValue([
      mockRun({
        id: 'manual-new',
        workSummary: 'Manual cleanup that should not be analyzed.',
        startedAt: 2000000,
        contextMeta: JSON.stringify({ agent: { id: 'agent-001', name: 'improve', triggeredBy: 'manual' } }),
      }),
      mockRun({
        id: 'scheduled-old',
        workSummary: 'Scheduled run that should be analyzed.',
        startedAt: 1000000,
      }),
    ])
    const runPrint = vi.fn(async (_prompt: string) => JSON.stringify({ concern: false, concernType: 'none', severity: 'low', summary: 'ok', recommendation: null }))
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(runPrint).toHaveBeenCalledOnce()
    const prompt = runPrint.mock.calls[0][0]
    expect(prompt).toContain('Scheduled run that should be analyzed.')
    expect(prompt).not.toContain('Manual cleanup that should not be analyzed.')
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 1000000 }])
  })

  it('does not call the runner when rows only contain manual runs', async () => {
    dbSelectMock.mockReturnValue([
      mockRun({
        contextMeta: JSON.stringify({ agent: { id: 'agent-001', name: 'improve', triggeredBy: 'manual' } }),
      }),
    ])
    const runPrint = vi.fn(async () => JSON.stringify({ concern: false, concernType: 'none', severity: 'low', summary: 'ok', recommendation: null }))
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(runPrint).not.toHaveBeenCalled()
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  function idleRun(overrides: Partial<{ id: string; workSummary: string; startedAt: number }> = {}) {
    return {
      id: overrides.id ?? 'idle-1',
      kind: 'agent:improve',
      workSummary: overrides.workSummary ?? 'No actionable target this pass.',
      runScore: 35,
      modifiedFiles: JSON.stringify([]),
      linesAdded: 0,
      linesRemoved: 0,
      startedAt: overrides.startedAt ?? 1000000,
      contextMeta: JSON.stringify({ agent: { id: 'agent-001', name: 'improve', triggeredBy: 'schedule' } }),
    }
  }

  function improveSentinelRun(overrides: Partial<{ id: string; startedAt: number }> = {}) {
    return idleRun({
      id: overrides.id ?? 'improve-sentinel',
      startedAt: overrides.startedAt,
      workSummary: 'IMPROVE_QUEUE_ROTATED: queue empty; no actionable work.',
    })
  }

  it('skips the LLM and retires open health concern when every analyzed run is idle', async () => {
    dbSelectMock.mockReturnValue([
      idleRun({ id: 'idle-3', startedAt: 3000000 }),
      improveSentinelRun({ id: 'idle-2', startedAt: 2000000 }),
      idleRun({ id: 'idle-1', startedAt: 1000000 }),
    ])
    const runPrint = vi.fn(async () => JSON.stringify({ concern: true, concernType: 'noise', severity: 'medium', summary: 's', recommendation: 'r' }))
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })

    // Idle-by-design → no LLM spend, no concern raised, stale concern retired.
    expect(runPrint).not.toHaveBeenCalled()
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
    expect(resolveRecommendationIfOpenMock).toHaveBeenCalledWith('alpha', 'orchestrator_agent_health', { agentId: 'agent-001', agentName: 'improve' })
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 3000000 }])
  })

  it('still analyzes (and annotates idle runs) when only some runs are idle', async () => {
    dbSelectMock.mockReturnValue([
      mockRun({ id: 'changed', workSummary: 'Touched the same file again.', startedAt: 3000000 }),
      improveSentinelRun({ id: 'idle-1', startedAt: 1000000 }),
    ])
    const runPrint = vi.fn(async (_prompt: string) => JSON.stringify({ concern: false, concernType: 'none', severity: 'low', summary: 'ok', recommendation: null }))
    await analyzeAgentHealth([candidateA], { runPrint })

    expect(runPrint).toHaveBeenCalledOnce()
    const prompt = runPrint.mock.calls[0][0]
    expect(prompt).toContain('[idle — reported no actionable work]')
    expect(prompt).toContain('idle is healthy, not a concern')
  })

  it('writes orchestrator_agent_health recommendation when concern=true', async () => {
    const runPrint = runPrintReturning({
      concern: true,
      concernType: 'loop',
      severity: 'high',
      summary: 'Agent keeps touching the same file.',
      recommendation: 'Review the prompt scope.',
    })
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(upsertRecommendationMock).toHaveBeenCalledOnce()
    const call = upsertRecommendationMock.mock.calls[0][0]
    expect(call.type).toBe('orchestrator_agent_health')
    expect(call.sourceKind).toBe('orchestrator')
    expect(call.agentId).toBe('agent-001')
    expect(call.project).toBe('alpha')
    expect(call.title).toContain('loop')
    expect(call.detail).toContain('Review the prompt scope.')
    expect(call.payload.concern).toBe(true)
    expect(call.payload.severity).toBe('high')
    expect(call.payload.avgRunScore).toBe(80)
    expect(call.payload.runsAnalyzed).toBe(3)
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 1000000 }])
  })

  it('retires any open health recommendation when concern=false', async () => {
    const runPrint = runPrintReturning({ concern: false, concernType: 'none', severity: 'low', summary: 'working well', recommendation: null })
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
    // Healthy now → auto-retire a stale loop/noise recommendation if one is open.
    expect(resolveRecommendationIfOpenMock).toHaveBeenCalledWith('alpha', 'orchestrator_agent_health', { agentId: 'agent-001', agentName: 'improve' })
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 1000000 }])
  })

  it('does not resolve when the runner returns null (gated/failed) — no verdict', async () => {
    const runPrint = runPrintReturning(null)
    await analyzeAgentHealth([candidateA], { runPrint })
    expect(resolveRecommendationIfOpenMock).not.toHaveBeenCalled()
  })

  it('does not write recommendation when the runner returns null (gated/failed)', async () => {
    const runPrint = runPrintReturning(null)
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
    expect(outcomes).toEqual([])
  })

  it('strips a markdown code fence around the JSON verdict', async () => {
    const runPrint = vi.fn(async () =>
      '```json\n{"concern":true,"concernType":"noise","severity":"medium","summary":"noisy","recommendation":"trim scope"}\n```',
    )
    const outcomes = await analyzeAgentHealth([candidateA], { runPrint })
    expect(upsertRecommendationMock).toHaveBeenCalledOnce()
    expect(upsertRecommendationMock.mock.calls[0][0].payload.concernType).toBe('noise')
    expect(outcomes).toMatchObject([{ agentId: 'agent-001', analyzed: true, latestRunStartedAt: 1000000 }])
  })

  it('swallows malformed JSON from the runner', async () => {
    const runPrint = vi.fn(async () => 'not-valid-json{')
    await expect(analyzeAgentHealth([candidateA], { runPrint })).resolves.toEqual([])
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
  })

  it('swallows runner errors and continues', async () => {
    const runPrint = vi.fn(async () => { throw new Error('spawn failed') })
    await expect(analyzeAgentHealth([candidateA], { runPrint })).resolves.toEqual([])
    expect(upsertRecommendationMock).not.toHaveBeenCalled()
  })

  it('processes multiple candidates independently', async () => {
    const candidateB: HealthCandidate = { id: 'agent-002', name: 'tests', project: 'beta' }
    dbSelectMock.mockReturnValue([
      mockRun({
        id: 'job-a',
        contextMeta: JSON.stringify({ agent: { id: 'agent-001', name: 'improve', triggeredBy: 'schedule' } }),
      }),
      mockRun({
        id: 'job-b',
        contextMeta: JSON.stringify({ agent: { id: 'agent-002', name: 'tests', triggeredBy: 'schedule' } }),
      }),
    ])
    const runPrint = runPrintReturning({ concern: true, concernType: 'noise', severity: 'medium', summary: 'noisy', recommendation: 'check scope' })
    const outcomes = await analyzeAgentHealth([candidateA, candidateB], { runPrint })
    expect(upsertRecommendationMock).toHaveBeenCalledTimes(2)
    expect(outcomes.map((o) => o.agentId)).toEqual(['agent-001', 'agent-002'])
  })
})
