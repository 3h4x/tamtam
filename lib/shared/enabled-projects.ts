import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

type ProjectRow = {
  name?: unknown;
  path?: unknown;
  enabled?: unknown;
  github?: unknown;
  priority?: unknown;
  testCommand?: unknown;
};

export type EnabledProject = {
  name: string;
  path: string;
  github?: string | null;
  priority?: string | null;
  testCommand?: string | null;
};

function isEnabled(value: unknown): boolean {
  return value === true || value === 1;
}

function normalizeProjects(rows: ProjectRow[]): EnabledProject[] {
  return rows
    .filter((row) => typeof row.name === 'string' && typeof row.path === 'string')
    .filter((row) => row.enabled === undefined || row.enabled === null || isEnabled(row.enabled))
    .map((row) => ({
      name: row.name as string,
      path: row.path as string,
      github: typeof row.github === 'string' || row.github === null ? row.github : undefined,
      priority: typeof row.priority === 'string' || row.priority === null ? row.priority : undefined,
      testCommand: typeof row.testCommand === 'string' || row.testCommand === null ? row.testCommand : undefined,
    }));
}

export function listEnabledProjects(): EnabledProject[] {
  if (!schema.projects) return [];

  try {
    const query = db.select().from(schema.projects);
    if (typeof (query as { where?: unknown }).where === 'function' && schema.projects.enabled) {
      const filtered = (query as { where: (arg: unknown) => { all: () => ProjectRow[] } })
        .where(eq(schema.projects.enabled, true))
        .all();
      return normalizeProjects(filtered);
    }
    if (typeof (query as { all?: unknown }).all === 'function') {
      return normalizeProjects((query as { all: () => ProjectRow[] }).all());
    }
  } catch {
    try {
      const query = db.select().from(schema.projects);
      if (typeof (query as { all?: unknown }).all === 'function') {
        return normalizeProjects((query as { all: () => ProjectRow[] }).all());
      }
    } catch {
      return [];
    }
  }

  return [];
}
