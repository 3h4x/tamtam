import { and, eq, isNotNull, or, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import * as schema from '@/lib/db/schema';

export type IssueRunSummaryBackfillCandidate = {
  id: string;
  logPath: string;
};

// Backfills are intentionally narrow: only finished issue-linked terminal runs
// that produced a log and still have no stored summary are eligible.
export function listIssueRunSummaryBackfillCandidates(): IssueRunSummaryBackfillCandidate[] {
  return db
    .select({
      id: schema.jobs.id,
      logPath: schema.jobs.logPath,
    })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.kind, 'run'),
      isNotNull(schema.jobs.ghIssueNumber),
      isNotNull(schema.jobs.logPath),
      isNotNull(schema.jobs.finishedAt),
      or(
        isNull(schema.jobs.workSummary),
        eq(schema.jobs.workSummary, ''),
      ),
    ))
    .all()
    .filter((row): row is IssueRunSummaryBackfillCandidate => typeof row.logPath === 'string' && row.logPath.length > 0);
}
