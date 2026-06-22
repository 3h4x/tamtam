import { NextResponse } from 'next/server';
import { fetchProjectData } from '@/lib/shared/project-data';
import { db, schema } from '@/lib/db';
import type { Task } from '@/lib/shared/types';

export async function GET() {
  try {
    const data = await fetchProjectData();
    // Stamp `project` from the object key without mutating the cached Task
    // instances — `fetchProjectData` returns a TTL-cached object shared across
    // requests, so in-place mutation would leak across responses.
    const tasks: Task[] = [];
    for (const [projectName, projectTasks] of Object.entries(data.projects)) {
      for (const task of projectTasks) tasks.push({ ...task, project: projectName });
    }

    // The issue-count enrichment is best-effort: a transient DB-pool timeout
    // here must not turn the whole projects list into a 500.
    const issueCounts: Record<string, { prs: number; issues: number }> = {};
    try {
      const cached = await db.select().from(schema.ghIssuesCache);
      for (const row of cached) {
        try {
          const prs = JSON.parse(row.prs) as unknown[];
          const issues = JSON.parse(row.issues) as unknown[];
          issueCounts[row.project] = { prs: prs.length, issues: issues.length };
        } catch { /* ignore malformed cache rows */ }
      }
    } catch (err) {
      console.error('[api/projects] issueCounts lookup failed (serving without):', err);
    }

    return NextResponse.json({ tasks, priorities: data.priorities, issueCounts });
  } catch (err) {
    console.error('[api/projects] failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
