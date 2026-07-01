import { eq } from 'drizzle-orm';
import { clearAgentsCache, normalizeAgent, type AgentRow, type NormalizedAgent } from '@/lib/agents/agents-cache';
import { db, schema } from '@/lib/db';
import { getRecommendation, updateRecommendationStatusIfCurrent, type RecommendationRow } from '@/lib/recommendations/recommendations';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { errMsg } from '@/lib/shared/types';

export class ApplyRecommendationError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApplyRecommendationError'
    this.status = status
  }
}

interface AppliedRecommendationResult {
  recommendation: RecommendationRow
  agent: NormalizedAgent
}

interface AgentUpdateResult {
  agent: NormalizedAgent
  rollback: () => Promise<void>
}

async function rollbackFailedApply(rollback: () => Promise<void>, cause: unknown): Promise<never> {
  console.error('Failed to update live agent schedule while applying recommendation:', errMsg(cause))
  try {
    await rollback()
  } catch (rollbackError: unknown) {
    console.error('Failed to roll back agent schedule after apply error:', errMsg(rollbackError))
    throw new ApplyRecommendationError(500, 'Failed to update live agent schedule; rollback also failed')
  }
  throw new ApplyRecommendationError(500, 'Failed to update live agent schedule')
}

function requireBackoffTarget(rec: RecommendationRow): { agentId: string; recommendedSchedule: string } {
  if (rec.type !== 'agent_schedule_backoff') {
    throw new ApplyRecommendationError(400, `Recommendation type "${rec.type}" is not auto-applicable`)
  }
  if (!rec.agent_id) {
    throw new ApplyRecommendationError(400, 'Recommendation is missing agent_id')
  }
  const recommendedSchedule = rec.payload?.recommendedSchedule
  if (typeof recommendedSchedule !== 'string' || !recommendedSchedule) {
    throw new ApplyRecommendationError(400, 'Recommendation payload is missing recommendedSchedule')
  }
  const parsed = parseOptionalAgentScheduleInput(recommendedSchedule)
  if (parsed.error || !parsed.schedule) {
    throw new ApplyRecommendationError(400, parsed.error ?? 'Recommendation payload is missing recommendedSchedule')
  }
  return { agentId: rec.agent_id, recommendedSchedule: parsed.schedule }
}

async function syncDbAgentSchedule(agent: AgentRow): Promise<void> {
  const skillIds: string[] = JSON.parse(agent.skillIds || '[]')
  if (agent.schedule && agent.enabled && (agent.prompt || skillIds.length > 0)) {
    await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name)
  } else {
    await uninstallAgentSchedule(agent.id, agent.project, agent.name)
  }
}

async function updateAgentSchedule(expectedProject: string, agentId: string, schedule: string): Promise<AgentUpdateResult> {
  const existingRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1)
  const existing = existingRows[0] ?? null
  if (!existing) {
    throw new ApplyRecommendationError(404, 'Agent not found')
  }
  if (existing.project !== expectedProject) {
    throw new ApplyRecommendationError(409, 'Recommendation target belongs to a different project')
  }
  if (existing.kind === 'system') {
    throw new ApplyRecommendationError(400, 'System agent schedule is managed by settings')
  }
  const previousSchedule = existing.schedule
  const rollback = async () => {
    await db.update(schema.agents)
      .set({ schedule: previousSchedule, updatedAt: Date.now() / 1000 })
      .where(eq(schema.agents.id, agentId))
      .execute()
    clearAgentsCache()
    const revertedRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1)
    const reverted = revertedRows[0] ?? null
    if (!reverted) return
    await syncDbAgentSchedule(reverted)
  }
  const nextUpdatedAt = Date.now() / 1000
  await db.update(schema.agents)
    .set({ schedule, updatedAt: nextUpdatedAt })
    .where(eq(schema.agents.id, agentId))
    .execute()
  clearAgentsCache()
  const updatedRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1)
  const updated = updatedRows[0] ?? null
  if (!updated) {
    await rollback()
    throw new ApplyRecommendationError(500, 'Agent not found after update')
  }
  try {
    await syncDbAgentSchedule(updated)
  } catch (e: unknown) {
    await rollbackFailedApply(rollback, e)
  }
  return {
    agent: normalizeAgent(updated),
    rollback,
  }
}

export async function applyRecommendation(project: string, recommendationId: string): Promise<AppliedRecommendationResult> {
  const recommendation = await getRecommendation(project, recommendationId)
  if (!recommendation) {
    throw new ApplyRecommendationError(404, 'Recommendation not found')
  }
  if (recommendation.status !== 'open') {
    throw new ApplyRecommendationError(409, 'Recommendation must be open to apply')
  }

  const { agentId, recommendedSchedule } = requireBackoffTarget(recommendation)
  const { agent, rollback } = await updateAgentSchedule(project, agentId, recommendedSchedule)

  const applied = await updateRecommendationStatusIfCurrent(project, recommendationId, 'open', 'applied')
  if (!applied) {
    await rollback()
    const latest = await getRecommendation(project, recommendationId)
    if (!latest) {
      throw new ApplyRecommendationError(404, 'Recommendation not found after apply')
    }
    throw new ApplyRecommendationError(409, `Recommendation is already ${latest.status}`)
  }

  return { recommendation: applied, agent }
}
