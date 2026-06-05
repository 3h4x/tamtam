import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, schema } from '@/lib/db';
import type { JobData } from '@/lib/jobs/types';

const KEY_PREFIX = 'agent_run_slot:';
const UNATTACHED_SLOT_STALE_SECONDS = 5 * 60;
// Backstop for an *attached* slot whose job row never finalizes. Normally an
// attached slot is released when its job finishes (`finished_at`/`aborted_at`
// set). But a job killed mid-run while the DB is unreachable (e.g. a Postgres
// outage) can leave a zombie row — `finished_at` and `aborted_at` both NULL —
// that `activeJobExists` reads as "still running" forever. Nothing reconciles
// it after the DB recovers, so the slot stays pinned and every new agent run
// for the project is rejected with 409 `already_running` indefinitely. This
// ceiling lets the slot self-heal: it sits well above the 30-min abandoned-job
// bound (`lib/jobs/auto-resume.ts`), so a genuinely long-running agent is never
// evicted, but a never-finalized zombie clears within the hour.
const ATTACHED_SLOT_HARD_STALE_SECONDS = 60 * 60;

type SlotValue = {
  token: string;
  project: string;
  agentId: string;
  agentName: string;
  claimedAt: number;
  jobId?: string;
};

export type DurableAgentRunSlotClaim =
  | { ok: true; token: string }
  | { ok: false; runningAgent: string; agentId?: string; jobId?: string };

function slotKey(project: string): string {
  return `${KEY_PREFIX}${project}`;
}

function parseSlot(value: string): SlotValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<SlotValue>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.project !== 'string' ||
      typeof parsed.agentId !== 'string' ||
      typeof parsed.agentName !== 'string' ||
      typeof parsed.claimedAt !== 'number'
    ) {
      return null;
    }
    return {
      token: parsed.token,
      project: parsed.project,
      agentId: parsed.agentId,
      agentName: parsed.agentName,
      claimedAt: parsed.claimedAt,
      jobId: typeof parsed.jobId === 'string' ? parsed.jobId : undefined,
    };
  } catch {
    return null;
  }
}

async function readSlot(project: string): Promise<SlotValue | null> {
  const rows = await db
    .select({ value: schema.maintenanceStatus.value })
    .from(schema.maintenanceStatus)
    .where(eq(schema.maintenanceStatus.key, slotKey(project)))
    .limit(1);
  return rows[0] ? parseSlot(rows[0].value) : null;
}

async function activeJobExists(jobId: string): Promise<boolean> {
  const rows = await db
    .select({
      finishedAt: schema.jobs.finishedAt,
      abortedAt: schema.jobs.abortedAt,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  const job = rows[0];
  return !!job && job.finishedAt == null && job.abortedAt == null;
}

async function clearStaleSlot(project: string, existing: SlotValue | null, nowSeconds: number): Promise<void> {
  if (!existing) return;

  if (existing.jobId) {
    if (await activeJobExists(existing.jobId)) {
      // Zombie backstop: the job row still reads active (finished_at NULL), but
      // if the slot was claimed longer ago than any real agent run could last,
      // the row never finalized (DB-outage casualty) — evict so the project
      // isn't blocked forever.
      if (nowSeconds - existing.claimedAt > ATTACHED_SLOT_HARD_STALE_SECONDS) {
        await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(project))).execute();
      }
      return;
    }
    await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(project))).execute();
    return;
  }

  if (nowSeconds - existing.claimedAt > UNATTACHED_SLOT_STALE_SECONDS) {
    await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(project))).execute();
  }
}

export async function tryClaimDurableAgentRunSlot(input: {
  project: string;
  agentId: string;
  agentName: string;
}): Promise<DurableAgentRunSlotClaim> {
  const nowSeconds = Date.now() / 1000;
  const key = slotKey(input.project);
  await clearStaleSlot(input.project, await readSlot(input.project), nowSeconds);

  const token = randomUUID();
  const value: SlotValue = {
    token,
    project: input.project,
    agentId: input.agentId,
    agentName: input.agentName,
    claimedAt: nowSeconds,
  };
  const inserted = await db
    .insert(schema.maintenanceStatus)
    .values({
      key,
      value: JSON.stringify(value),
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing()
    .returning({ key: schema.maintenanceStatus.key })
    .execute();

  if (inserted.length > 0) return { ok: true, token };

  const holder = await readSlot(input.project);
  return {
    ok: false,
    runningAgent: holder?.agentName ?? 'unknown',
    agentId: holder?.agentId,
    jobId: holder?.jobId,
  };
}

export async function attachJobToDurableAgentRunSlot(project: string, token: string, jobId: string): Promise<boolean> {
  const existing = await readSlot(project);
  if (!existing || existing.token !== token) return false;
  const next: SlotValue = { ...existing, jobId };
  await db
    .update(schema.maintenanceStatus)
    .set({ value: JSON.stringify(next), updatedAt: Date.now() / 1000 })
    .where(eq(schema.maintenanceStatus.key, slotKey(project)))
    .execute();
  return true;
}

export async function releaseDurableAgentRunSlot(project: string, token: string): Promise<void> {
  const existing = await readSlot(project);
  if (!existing || existing.token !== token) return;
  await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(project))).execute();
}

export async function releaseDurableAgentRunSlotForJob(job: Pick<JobData, 'project' | 'id'>): Promise<void> {
  const existing = await readSlot(job.project);
  if (!existing || existing.jobId !== job.id) return;
  await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(job.project))).execute();
}

export async function clearDurableAgentRunSlot(project: string): Promise<void> {
  await db.delete(schema.maintenanceStatus).where(eq(schema.maintenanceStatus.key, slotKey(project))).execute();
}
