// Auto-seeds built-in system agents for every enabled project. Runs once
// at TamTam boot and again whenever a project is created. Idempotent —
// a row with the same (project, name) is left alone. A dismissal marker
// (settings key `system_agent_dismissed:<project>:<name>`) lets users
// hard-delete a system agent without it getting recreated on next boot.

import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listEnabledProjects, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { listSystemAgentSeedConfigs, type SystemAgentSeedConfig } from './index';

export interface SeedSystemAgentsResult {
  seeded: number;
  skipped: number;
  dismissed: number;
}

function buildAgentId(project: string, name: string): string {
  return `system:${project}:${name}`;
}

export function dismissalKey(project: string, name: string): string {
  return `system_agent_dismissed:${project}:${name}`;
}

async function isDismissed(project: string, name: string): Promise<boolean> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, dismissalKey(project, name)))
    .limit(1);
  return rows.length > 0 && rows[0].value === 'true';
}

async function seedOneAgentForOneProject(
  project: string,
  seed: SystemAgentSeedConfig,
  options: { projectPath?: string | null } = {},
): Promise<'seeded' | 'skipped' | 'dismissed'> {
  if (await isDismissed(project, seed.name)) return 'dismissed';
  if (await findAgentNameConflict(project, seed.name, { projectPath: options.projectPath })) return 'skipped';
  const now = Date.now() / 1000;
  try {
    await db.insert(schema.agents).values({
      id: buildAgentId(project, seed.name),
      name: seed.name,
      project,
      skillIds: '[]',
      model: seed.model,
      prompt: seed.prompt,
      schedule: seed.defaultSchedule,
      enabled: true,
      docPaths: '[]',
      provider: null,
      fallbackEnabled: false,
      prerequisiteCommand: null,
      kind: 'system',
      createdAt: now,
      updatedAt: now,
    }).execute();
    return 'seeded';
  } catch (err) {
    // Unique-constraint races — the column has a unique primary key so two
    // concurrent boots could collide. Treat duplicates as "already seeded".
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      return 'skipped';
    }
    throw err;
  }
}

export async function seedSystemAgents(): Promise<SeedSystemAgentsResult> {
  // Boot is the first realm to touch this — projects cache may be cold.
  try { await refreshProjectsCacheSync(); } catch { /* table may be missing in tests */ }
  const projects = listEnabledProjects({ includeArchived: false });
  const seeds = listSystemAgentSeedConfigs();
  let seeded = 0;
  let skipped = 0;
  let dismissed = 0;
  for (const project of projects) {
    for (const seed of seeds) {
      try {
        const outcome = await seedOneAgentForOneProject(project.name, seed, {
          projectPath: project.path,
        });
        if (outcome === 'seeded') seeded += 1;
        else if (outcome === 'dismissed') dismissed += 1;
        else skipped += 1;
      } catch (err) {
        console.error(`[system-agents] seed failed for ${project.name}/${seed.name}:`, err);
      }
    }
  }
  return { seeded, skipped, dismissed };
}

export async function seedSystemAgentsForProject(project: string): Promise<SeedSystemAgentsResult> {
  const seeds = listSystemAgentSeedConfigs();
  let seeded = 0;
  let skipped = 0;
  let dismissed = 0;
  for (const seed of seeds) {
    try {
      const outcome = await seedOneAgentForOneProject(project, seed);
      if (outcome === 'seeded') seeded += 1;
      else if (outcome === 'dismissed') dismissed += 1;
      else skipped += 1;
    } catch (err) {
      console.error(`[system-agents] seed failed for ${project}/${seed.name}:`, err);
    }
  }
  return { seeded, skipped, dismissed };
}

export async function markSystemAgentDismissed(project: string, name: string): Promise<void> {
  await db.insert(schema.settings)
    .values({ key: dismissalKey(project, name), value: 'true' })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: 'true' },
    })
    .execute();
}
