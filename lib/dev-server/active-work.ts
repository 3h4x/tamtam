// Helper: is there any active (running) agent run or release for a project?
//
// Used by the dev server lifecycle:
//   - Agent completion hook: if the agent triggered a release, this returns
//     true (the new release job is in DB before this fires) and we skip the
//     dev server stop. Release finalize will own the stop.
//   - Release finalize hook: the release row is marked finished BEFORE this
//     check fires, so the check correctly returns false on the project (no
//     other active work) and we stop the server.
//   - Boot sweep: orphan pidfiles whose project has no active work get
//     stopped on boot.

import { and, eq, isNull, inArray, or, like } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

const AGENT_LIKE_KINDS = ['release', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'soak'];

export async function hasActiveWorkForProject(project: string): Promise<boolean> {
  // Any unfinished job with kind in (release | pipeline phases | agent:*).
  // Single query with OR — pipeline-kind match + `agent:%` LIKE match.
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.project, project),
        isNull(schema.jobs.finishedAt),
        or(
          inArray(schema.jobs.kind, AGENT_LIKE_KINDS),
          like(schema.jobs.kind, 'agent:%'),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
