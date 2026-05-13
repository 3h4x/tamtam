import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { db, schema } from '@/lib/db';
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(2));
  return p;
}

function scanGitRepos(workspacePath: string): { name: string; path: string }[] {
  const expanded = expandHome(workspacePath);
  if (!existsSync(/*turbopackIgnore: true*/ expanded)) return [];

  const repos: { name: string; path: string }[] = [];
  const skipDirs = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.venv', '__pycache__']);

  try {
    const entries = readdirSync(/*turbopackIgnore: true*/ expanded, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
      const dirPath = join(expanded, entry.name);
      if (existsSync(/*turbopackIgnore: true*/ join(dirPath, '.git'))) {
        repos.push({ name: entry.name, path: dirPath });
      }
    }
  } catch {
    return [];
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET() {
  const setting = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, 'workspace_path'))
    .get();
  const workspacePath = setting?.value || '';

  const savedProjects = db.select().from(schema.projects).all();
  const savedMap = new Map(savedProjects.map((p) => [p.name, p]));

  const discovered = workspacePath ? scanGitRepos(workspacePath) : [];

  const projects = discovered.map((repo) => {
    const saved = savedMap.get(repo.name);
    let customActions: { name: string; command: string }[] = [];
    if (saved?.customActions) {
      try { customActions = JSON.parse(saved.customActions); } catch {}
    }
    return {
      name: repo.name,
      path: repo.path,
      enabled: saved?.enabled ?? false,
      github: saved?.github ?? null,
      priority: saved?.priority ?? null,
      archived: saved?.archived ?? false,
      custom_actions: customActions,
    };
  });

  return NextResponse.json({
    workspace_path: workspacePath,
    projects,
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { projects } = body as {
    projects: { name: string; path: string; enabled: boolean; github?: string; priority?: string; custom_actions?: { name: string; command: string; color?: string }[] }[];
  };

  if (!Array.isArray(projects)) {
    return NextResponse.json({ detail: 'projects must be an array' }, { status: 400 });
  }

  for (const proj of projects) {
    const actionsJson = proj.custom_actions ? JSON.stringify(proj.custom_actions) : null;
    db.insert(schema.projects)
      .values({
        name: proj.name,
        path: proj.path,
        enabled: proj.enabled,
        github: proj.github || null,
        priority: proj.priority || null,
        customActions: actionsJson,
      })
      .onConflictDoUpdate({
        target: schema.projects.name,
        set: {
          path: proj.path,
          enabled: proj.enabled,
          github: proj.github || null,
          priority: proj.priority || null,
          customActions: actionsJson,
        },
      })
      .run();
  }

  return NextResponse.json({ status: 'ok' });
}
