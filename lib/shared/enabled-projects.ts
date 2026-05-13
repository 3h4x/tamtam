import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

type ProjectRow = {
  name?: unknown;
  path?: unknown;
  enabled?: unknown;
  github?: unknown;
  priority?: unknown;
  testCommand?: unknown;
  archived?: unknown;
};

export type EnabledProject = {
  name: string;
  path: string;
  github?: string | null;
  priority?: string | null;
  testCommand?: string | null;
  archived?: boolean;
};

function isEnabled(value: unknown): boolean {
  return value === true || value === 1;
}

function isArchived(value: unknown): boolean {
  return value === true || value === 1;
}

function normalizeProjects(rows: ProjectRow[], includeArchived: boolean): EnabledProject[] {
  return rows
    .filter((row) => typeof row.name === 'string' && typeof row.path === 'string')
    .filter((row) => row.enabled === undefined || row.enabled === null || isEnabled(row.enabled))
    .filter((row) => includeArchived || !isArchived(row.archived))
    .map((row) => ({
      name: row.name as string,
      path: row.path as string,
      github: typeof row.github === 'string' || row.github === null ? row.github : undefined,
      priority: typeof row.priority === 'string' || row.priority === null ? row.priority : undefined,
      testCommand: typeof row.testCommand === 'string' || row.testCommand === null ? row.testCommand : undefined,
      archived: isArchived(row.archived),
    }));
}

export function listEnabledProjects(options: { includeArchived?: boolean } = {}): EnabledProject[] {
  const includeArchived = options.includeArchived === true;
  if (!schema.projects) return [];

  try {
    const query = db.select().from(schema.projects);
    if (typeof (query as { where?: unknown }).where === 'function' && schema.projects.enabled) {
      const filtered = (query as { where: (arg: unknown) => { all: () => ProjectRow[] } })
        .where(eq(schema.projects.enabled, true))
        .all();
      return normalizeProjects(filtered, includeArchived);
    }
    if (typeof (query as { all?: unknown }).all === 'function') {
      return normalizeProjects((query as { all: () => ProjectRow[] }).all(), includeArchived);
    }
  } catch {
    try {
      const query = db.select().from(schema.projects);
      if (typeof (query as { all?: unknown }).all === 'function') {
        return normalizeProjects((query as { all: () => ProjectRow[] }).all(), includeArchived);
      }
    } catch {
      return [];
    }
  }

  return [];
}

export function isProjectArchived(name: string): boolean {
  try {
    const row = db
      .select({ archived: schema.projects.archived })
      .from(schema.projects)
      .where(eq(schema.projects.name, name))
      .get();
    return isArchived(row?.archived);
  } catch {
    return false;
  }
}

export function isProjectPaused(name: string): boolean {
  try {
    const row = db
      .select({ paused: schema.projects.paused })
      .from(schema.projects)
      .where(eq(schema.projects.name, name))
      .get();
    return isArchived(row?.paused as unknown);
  } catch {
    return false;
  }
}
