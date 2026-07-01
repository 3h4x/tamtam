// Auto-seeds built-in system agents for every enabled project. Runs once
// at TamTam boot and again whenever a project is created. Idempotent —
// a row with the same (project, name) is left alone. A dismissal marker
// (settings key `system_agent_dismissed:<project>:<name>`) lets users
// hard-delete a system agent without it getting recreated on next boot.

import { eq, like } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { listEnabledProjects, refreshProjectsCacheSync } from '@/lib/shared/enabled-projects';
import { findAgentNameConflict } from '@/lib/agents/agent-conflicts';
import { getSettings } from '@/lib/shared/config';
import { DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME } from './constants';
import { listSystemAgentSeedConfigs, type SystemAgentSeedConfig } from './index';

// System-agent schedules are user-facing settings, not seed-config defaults.
// `documentation-reindex-vectors` reads its interval from
// `retrieval_reindex_interval_hours` so it stays user-tunable from /settings.
function effectiveScheduleFor(seed: SystemAgentSeedConfig): string {
  if (seed.name === DOCUMENTATION_REINDEX_VECTORS_AGENT_NAME) {
    return `${getSettings().retrieval_reindex_interval_hours}h`;
  }
  return seed.defaultSchedule;
}

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

// Bulk-load every `system_agent_dismissed:*` row in one query. Used by the
// batch seeder (`seedSystemAgents`) to avoid P×S round-trips when checking
// per-(project, seed) dismissal state.
async function loadAllDismissedKeys(): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .where(like(schema.settings.key, 'system_agent_dismissed:%'));
    const out = new Set<string>();
    for (const r of rows) {
      if (r.value === 'true') out.add(r.key);
    }
    return out;
  } catch {
    return new Set();
  }
}

async function seedOneAgentForOneProject(
  project: string,
  seed: SystemAgentSeedConfig,
  options: { dismissedSet?: ReadonlySet<string> } = {},
): Promise<'seeded' | 'skipped' | 'dismissed'> {
  // Parallelize the two independent pre-checks (dismissal lookup + conflict
  // lookup). When the caller bulk-loaded the dismissal set, the dismissal
  // check is in-memory and only the conflict lookup awaits.
  const dismissedPromise = options.dismissedSet
    ? Promise.resolve(options.dismissedSet.has(dismissalKey(project, seed.name)))
    : isDismissed(project, seed.name);
  const conflictPromise = findAgentNameConflict(project, seed.name);
  const [dismissed, conflict] = await Promise.all([dismissedPromise, conflictPromise]);
  if (dismissed) return 'dismissed';
  if (conflict) return 'skipped';
  const now = Date.now() / 1000;
  try {
    await db.insert(schema.agents).values({
      id: buildAgentId(project, seed.name),
      name: seed.name,
      project,
      skillIds: '[]',
      model: seed.model,
      prompt: seed.prompt,
      schedule: effectiveScheduleFor(seed),
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
  // Single bulk query for every `system_agent_dismissed:*` row instead of
  // P×S point lookups during the nested seed loop.
  const dismissedSet = await loadAllDismissedKeys();
  let seeded = 0;
  let skipped = 0;
  let dismissed = 0;
  for (const project of projects) {
    for (const seed of seeds) {
      try {
        const outcome = await seedOneAgentForOneProject(project.name, seed, {
          dismissedSet,
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
