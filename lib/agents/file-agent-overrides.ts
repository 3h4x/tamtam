import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { normalizeModelInput } from '@/lib/agents/model-aliases';

// Per-file-agent runtime overrides. The .md file in `.tamtam/agents/<name>.md`
// owns the agent's existence and its prompt body — anything that's part of
// the agent's *definition* and worth committing to git. Everything operational
// (enabled flag, cron schedule, model, runner, skill picks) belongs to the
// running environment and lives here in the DB instead, so a UI toggle
// doesn't dirty a tracked file.
//
// Stored in the existing `settings` table to avoid a schema migration:
// key = `agent_override:<project>:<name>`, value = JSON.

export interface FileAgentOverride {
  enabled?: boolean;
  schedule?: string | null;
  model?: string;
  runner?: string;
  skillIds?: string[];
}

function keyFor(project: string, name: string): string {
  return `agent_override:${project}:${name}`;
}

export function getFileAgentOverride(project: string, name: string): FileAgentOverride | null {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(project, name)))
      .get();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as FileAgentOverride;
    if (parsed && typeof parsed === 'object') {
      return {
        ...parsed,
        model: parsed.model === undefined ? undefined : normalizeModelInput(parsed.model, 'normal'),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setFileAgentOverride(project: string, name: string, patch: FileAgentOverride): FileAgentOverride {
  const existing = getFileAgentOverride(project, name) ?? {};
  const next: FileAgentOverride = { ...existing };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.schedule !== undefined) next.schedule = patch.schedule;
  if (patch.model !== undefined) next.model = normalizeModelInput(patch.model, 'normal');
  if (patch.runner !== undefined) next.runner = patch.runner;
  if (patch.skillIds !== undefined) next.skillIds = patch.skillIds;
  const value = JSON.stringify(next);
  db.insert(schema.settings)
    .values({ key: keyFor(project, name), value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
  return next;
}

export function deleteFileAgentOverride(project: string, name: string): void {
  try {
    db.delete(schema.settings).where(eq(schema.settings.key, keyFor(project, name))).run();
  } catch { /* non-fatal */ }
}
