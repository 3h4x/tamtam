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
// `rows` keeps insertion order for the list path; `byName` is a parallel
// index for the per-project lookups (`isProjectArchived`, `isProjectPaused`).
// Without the index, both helpers ran an O(N) `Array.find` per call — and
// the cron task hits them once per agent fire, so a workspace with N
// projects and K scheduled agents was paying O(N×K) per polling window
// for what's structurally a Map lookup.
let _projectsCache: { rows: ProjectRow[]; byName: Map<string, ProjectRow>; time: number } | null = null;
let _projectsRefreshPromise: Promise<void> | null = null;

async function _refreshProjectsFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(schema.projects);
    const byName = new Map<string, ProjectRow>(rows.map((row) => [row.name, row]));
    _projectsCache = { rows, byName, time: Date.now() / 1000 };
  } catch (e) {
    console.error('[enabled-projects] refresh failed:', e);
  }
}

function _doProjectsRefresh(): Promise<void> {
  if (!_projectsRefreshPromise) {
    _projectsRefreshPromise = _refreshProjectsFromDb().finally(() => {
      _projectsRefreshPromise = null;
    });
  }
  return _projectsRefreshPromise;
}

function _getCachedRows(): ProjectRow[] {
  const now = Date.now() / 1000;
  if (_projectsCache && now - _projectsCache.time < PROJECTS_CACHE_TTL) return _projectsCache.rows;
  void _doProjectsRefresh();
  return _projectsCache?.rows ?? [];
}

function _getCachedByName(): Map<string, ProjectRow> {
  const now = Date.now() / 1000;
  if (_projectsCache && now - _projectsCache.time < PROJECTS_CACHE_TTL) return _projectsCache.byName;
  void _doProjectsRefresh();
  return _projectsCache?.byName ?? new Map();
}

export function clearProjectsCache(): void {
  _projectsCache = null;
}

// Awaitable, blocking refresh for write paths that must make the synchronous
// readers observe fresh project state before returning.
export async function refreshProjectsCacheSync(): Promise<void> {
  const inFlight = _projectsRefreshPromise;
  if (inFlight) await inFlight;
  await _refreshProjectsFromDb();
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
  return _getCachedByName().get(name)?.archived ?? false;
}

export function isProjectPaused(name: string): boolean {
  return _getCachedByName().get(name)?.paused ?? false;
}
