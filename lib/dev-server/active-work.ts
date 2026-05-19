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

import { and, eq, isNull, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';

const AGENT_LIKE_KINDS = ['release', 'test', 'review', 'fix', 'commit', 'push', 'pr-wait', 'mark-dod', 'soak'];

export async function hasActiveWorkForProject(project: string): Promise<boolean> {
  // Any unfinished job with kind in (release | pipeline phases | agent:*).
  // Agent kinds are prefixed `agent:` — we LIKE-match those with a separate
  // query because Drizzle's `like` is fine here.
  const released = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.project, project),
        isNull(schema.jobs.finishedAt),
        inArray(schema.jobs.kind, AGENT_LIKE_KINDS),
      ),
    )
    .limit(1);
  if (released.length > 0) return true;

  // Agent runs (kind starts with `agent:`).
  const { sql } = await import('drizzle-orm');
  const agents = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.project, project),
        isNull(schema.jobs.finishedAt),
        sql`${schema.jobs.kind} LIKE 'agent:%'`,
      ),
    )
    .limit(1);
  return agents.length > 0;
}
