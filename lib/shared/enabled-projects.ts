import { db, schema } from '@/lib/db';

type ProjectRow = typeof schema.projects.$inferSelect;

export type EnabledProject = {
  name: string;
  path: string;
  github?: string | null;
  priority?: string | null;
  testCommand?: string | null;
  archived?: boolean;
  paused?: boolean;
};

const PROJECTS_CACHE_TTL = 10; // seconds
let _projectsCache: { rows: ProjectRow[]; time: number } | null = null;
let _projectsRefreshing = false;

async function _doProjectsRefresh(): Promise<void> {
  if (_projectsRefreshing) return;
  _projectsRefreshing = true;
  try {
    const rows = await db.select().from(schema.projects);
    _projectsCache = { rows, time: Date.now() / 1000 };
  } catch (e) {
    console.error('[enabled-projects] refresh failed:', e);
  } finally {
    _projectsRefreshing = false;
  }
}

function _getCachedRows(): ProjectRow[] {
  const now = Date.now() / 1000;
  if (_projectsCache && now - _projectsCache.time < PROJECTS_CACHE_TTL) return _projectsCache.rows;
  void _doProjectsRefresh();
  return _projectsCache?.rows ?? [];
}

export function clearProjectsCache(): void {
  _projectsCache = null;
}

// Test-only: awaitable, blocking refresh so callers can prime the cache
// without polling. Production code keeps the lazy fire-and-forget path.
export async function refreshProjectsCacheSync(): Promise<void> {
  const wasRefreshing = _projectsRefreshing;
  _projectsRefreshing = false;
  try {
    await _doProjectsRefresh();
  } finally {
    if (wasRefreshing) _projectsRefreshing = true;
  }
}

function normalizeRow(row: ProjectRow): EnabledProject {
  return {
    name: row.name,
    path: row.path,
    github: row.github ?? null,
    priority: row.priority ?? null,
    testCommand: row.testCommand ?? null,
    archived: row.archived ?? false,
    paused: row.paused ?? false,
  };
}

export function listEnabledProjects(options: { includeArchived?: boolean } = {}): EnabledProject[] {
  const includeArchived = options.includeArchived === true;
  return _getCachedRows()
    .filter((row) => row.enabled !== false)
    .filter((row) => includeArchived || !row.archived)
    .map(normalizeRow);
}

export function isProjectArchived(name: string): boolean {
  const row = _getCachedRows().find((r) => r.name === name);
  return row?.archived ?? false;
}

export function isProjectPaused(name: string): boolean {
  const row = _getCachedRows().find((r) => r.name === name);
  return row?.paused ?? false;
}
