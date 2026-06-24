import { db, schema } from '@/lib/db';
import { eq, like } from 'drizzle-orm';
import { normalizeModelInput } from '@/lib/agents/model-aliases';
import type { AutopilotState } from '@/lib/orchestrator/agent-autopilot';

// Per-file-agent runtime overrides. The .md file in `.tamtam/agents/<name>.md`
// owns the agent's existence and its prompt body — anything that's part of
// the agent's *definition* and worth committing to git. Everything operational
// (enabled flag, cron schedule, model, skill picks) belongs to the
// running environment and lives here in the DB instead, so a UI toggle
// doesn't dirty a tracked file.
//
// Stored in the existing `settings` table to avoid a schema migration:
// key = `agent_override:<project>:<name>`, value = JSON.

export interface FileAgentOverride {
  enabled?: boolean;
  boostable?: boolean;
  schedule?: string | null;
  model?: string;
  skillIds?: string[];
  permissionMode?: string | null;
  // Agent role (operator override / inferred). Drives autopilot policy.
  role?: string;
  // Runtime autopilot overrides + streak counters. File agents have no DB row,
  // so their autopilot state rides here in the override (JSON) instead of the
  // `agents.autopilot_state` column used for DB agents.
  autopilotState?: AutopilotState;
}

function keyFor(project: string, name: string): string {
  return `agent_override:${project}:${name}`;
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache for sync callers (e.g. tamtam-file-agents.ts
// which builds FileAgent objects inside synchronous scanFileAgents / loadFileAgent).
// The cache entry holds the last resolved value. On each sync read we kick off
// an async background refresh so the next read is fresh. Writes invalidate the
// entry immediately so reads after a write see the new value promptly.
//
// Pinned to globalThis — Next.js duplicates modules across realms, so a
// module-level Map would mean each route bundle keeps its own copy and the
// warm-cache + sync-read consistency story breaks. Same singleton pattern as
// __tamtamCronWorker / __tamtamJobCancellation.
// ---------------------------------------------------------------------------
declare global {
  var __tamtamFileAgentOverrideCache: Map<string, FileAgentOverride | null> | undefined;
  var __tamtamFileAgentOverridePending: Set<string> | undefined;
}

const _overrideCache: Map<string, FileAgentOverride | null> =
  globalThis.__tamtamFileAgentOverrideCache ?? new Map();
globalThis.__tamtamFileAgentOverrideCache = _overrideCache;

const _overridePending: Set<string> =
  globalThis.__tamtamFileAgentOverridePending ?? new Set();
globalThis.__tamtamFileAgentOverridePending = _overridePending;

function refreshOverrideCache(key: string, project: string, name: string): void {
  if (_overridePending.has(key)) return;
  _overridePending.add(key);
  void getFileAgentOverride(project, name)
    .then((v) => { _overrideCache.set(key, v); })
    .catch(() => { /* keep stale */ })
    .finally(() => { _overridePending.delete(key); });
}

/**
 * Synchronous read that returns the cached override (may be stale on first
 * call) and kicks off a background refresh. Use this only in contexts that
 * cannot be made async (e.g. buildFileAgent inside scanFileAgents).
 */
export function getFileAgentOverrideSync(project: string, name: string): FileAgentOverride | null {
  const key = keyFor(project, name);
  refreshOverrideCache(key, project, name);
  return _overrideCache.get(key) ?? null;
}

/** Invalidate the sync cache for a given key after a write. */
function invalidateOverrideCache(project: string, name: string): void {
  _overrideCache.delete(keyFor(project, name));
}

function clearFileAgentListCache(): void {
  globalThis.__tamtamAllFileAgentsCache = null;
}

/**
 * Bulk-load every override row from the DB into the sync cache. Async callers
 * (e.g. the cron-task agent loader) can `await` this before scanning file
 * agents so the SWR cache returns fresh data on the first sync read instead
 * of `null` + a background refresh.
 */
export async function warmFileAgentOverrideCache(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(like(schema.settings.key, 'agent_override:%'));
    for (const row of rows) {
      if (!row.value) continue;
      // Validate the full `agent_override:<project>:<name>` shape — the LIKE
      // prefix only checks the first colon; rows lacking the second one are
      // malformed and we skip them silently.
      const rest = row.key.slice('agent_override:'.length);
      if (!rest.includes(':')) continue;
      try {
        const parsed = JSON.parse(row.value) as FileAgentOverride;
        if (parsed && typeof parsed === 'object') {
          _overrideCache.set(row.key, {
            ...parsed,
            model: parsed.model === undefined ? undefined : normalizeModelInput(parsed.model, 'normal'),
          });
        }
      } catch {
        // skip malformed rows
      }
    }
  } catch (e) {
    console.error('[file-agent-overrides] warm cache failed:', e);
  }
}

export async function getFileAgentOverride(project: string, name: string): Promise<FileAgentOverride | null> {
  try {
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keyFor(project, name)))
      .limit(1);
    const row = rows[0] ?? null;
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

export async function setFileAgentOverride(project: string, name: string, patch: FileAgentOverride): Promise<FileAgentOverride> {
  const existing = (await getFileAgentOverride(project, name)) ?? {};
  const next: FileAgentOverride = { ...existing };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.boostable !== undefined) next.boostable = patch.boostable;
  if (patch.schedule !== undefined) next.schedule = patch.schedule;
  if (patch.model !== undefined) next.model = normalizeModelInput(patch.model, 'normal');
  if (patch.skillIds !== undefined) next.skillIds = patch.skillIds;
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.autopilotState !== undefined) next.autopilotState = patch.autopilotState;
  const value = JSON.stringify(next);
  await db.insert(schema.settings)
    .values({ key: keyFor(project, name), value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .execute();
  // Update the sync cache so callers that use getFileAgentOverrideSync see the
  // new value on the next call without waiting for the background refresh.
  _overrideCache.set(keyFor(project, name), next);
  clearFileAgentListCache();
  return next;
}

export function deleteFileAgentOverride(project: string, name: string): void {
  invalidateOverrideCache(project, name);
  clearFileAgentListCache();
  void db.delete(schema.settings)
    .where(eq(schema.settings.key, keyFor(project, name)))
    .execute()
    .catch((e) => console.error('[file-agent-overrides] delete failed:', e));
}
