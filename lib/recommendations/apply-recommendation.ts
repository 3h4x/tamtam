import { eq } from 'drizzle-orm';
import { clearAgentsCache, normalizeAgent, type AgentRow, type NormalizedAgent } from '@/lib/agents/agents-cache';
import { setFileAgentOverride } from '@/lib/agents/file-agent-overrides';
import { loadFileAgent, parseFileAgentId, writeFileAgent, type FileAgent } from '@/lib/agents/tamtam-file-agents';
import { db, schema } from '@/lib/db';
import { getRecommendation, updateRecommendationStatusIfCurrent, type RecommendationRow } from '@/lib/recommendations/recommendations';
import { installAgentSchedule, uninstallAgentSchedule } from '@/lib/scheduling/agent-scheduler';
import { parseOptionalAgentScheduleInput } from '@/lib/scheduling/agent-schedule';
import { resolveProjectPath } from '@/lib/shared/project-data';
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
  agent: FileAgent | NormalizedAgent
}

interface AgentUpdateResult {
  agent: FileAgent | NormalizedAgent
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

async function syncFileAgentSchedule(agent: FileAgent): Promise<void> {
  if (agent.schedule && agent.enabled && (agent.prompt || agent.skillIds.length > 0)) {
    await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name)
  } else {
    await uninstallAgentSchedule(agent.id, agent.project, agent.name)
  }
}

async function syncDbAgentSchedule(agent: AgentRow): Promise<void> {
  const skillIds: string[] = JSON.parse(agent.skillIds || '[]')
  if (agent.schedule && agent.enabled && (agent.prompt || skillIds.length > 0)) {
    await installAgentSchedule(agent.id, agent.schedule, agent.prompt, agent.project, agent.name)
  } else {
    await uninstallAgentSchedule(agent.id, agent.project, agent.name)
  }
}

async function updateFileAgentSchedule(expectedProject: string, agentId: string, schedule: string): Promise<AgentUpdateResult> {
  const parsed = parseFileAgentId(agentId)
  if (!parsed) {
    throw new ApplyRecommendationError(500, 'Expected file agent id')
  }
  if (parsed.project !== expectedProject) {
    throw new ApplyRecommendationError(409, 'Recommendation target belongs to a different project')
  }
  const projectPath = resolveProjectPath(parsed.project)
  if (!projectPath) {
    throw new ApplyRecommendationError(404, 'Agent project path not found')
  }
  const existing = loadFileAgent(projectPath, parsed.project, parsed.name)
  if (!existing) {
    throw new ApplyRecommendationError(404, 'Agent not found')
  }
  const previousSchedule = existing.schedule
  const rollback = async () => {
    await setFileAgentOverride(parsed.project, parsed.name, { schedule: previousSchedule })
    const reverted = loadFileAgent(projectPath, parsed.project, parsed.name)
    if (reverted) await syncFileAgentSchedule(reverted)
  }
  await setFileAgentOverride(parsed.project, parsed.name, { schedule })
  const updated = loadFileAgent(projectPath, parsed.project, parsed.name)
  if (!updated) {
    await rollback()
    throw new ApplyRecommendationError(500, 'Agent not found after update')
  }
  try {
    await syncFileAgentSchedule(updated)
  } catch (e: unknown) {
    await rollbackFailedApply(rollback, e)
  }
  return {
    agent: updated,
    rollback,
  }
}

async function updateDbAgentSchedule(expectedProject: string, agentId: string, schedule: string): Promise<AgentUpdateResult> {
  const existingRows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1)
  const existing = existingRows[0] ?? null
  if (!existing) {
    throw new ApplyRecommendationError(404, 'Agent not found')
  }
  if (existing.project !== expectedProject) {
    throw new ApplyRecommendationError(409, 'Recommendation target belongs to a different project')
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
    const revertedProjectPath = resolveProjectPath(reverted.project)
    if (revertedProjectPath) {
      try {
        writeFileAgent(revertedProjectPath, reverted.project, reverted.name, {
          prompt: reverted.prompt,
          model: reverted.model,
          schedule: reverted.schedule,
          skillIds: JSON.parse(reverted.skillIds || '[]'),
          enabled: reverted.enabled,
          boostable: reverted.boostable,
          provider: reverted.provider,
        })
      } catch {
        // Keep parity with the PATCH route: file sync is best-effort.
      }
    }
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
  const projectPath = resolveProjectPath(updated.project)
  if (projectPath) {
    try {
      writeFileAgent(projectPath, updated.project, updated.name, {
        prompt: updated.prompt,
        model: updated.model,
        schedule: updated.schedule,
        skillIds: JSON.parse(updated.skillIds || '[]'),
        enabled: updated.enabled,
        boostable: updated.boostable,
        provider: updated.provider,
      })
    } catch {
      // Keep parity with the PATCH route: file sync is best-effort.
    }
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

async function updateAgentSchedule(expectedProject: string, agentId: string, schedule: string): Promise<AgentUpdateResult> {
  if (parseFileAgentId(agentId)) {
    return updateFileAgentSchedule(expectedProject, agentId, schedule)
  }
  return updateDbAgentSchedule(expectedProject, agentId, schedule)
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
