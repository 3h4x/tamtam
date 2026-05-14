import { openDb } from './issue-run-summary-utils.mjs';

function parseIssueNumber(summary) {
  const match = summary.match(/(?:issue\s+|#)(\d{1,6})\b/i);
  if (!match) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function main() {
  const db = openDb();
  try {
    const rows = (await db.query(`
      SELECT id, work_summary AS "workSummary"
      FROM jobs
      WHERE kind = 'agent:issue-cruncher'
        AND gh_issue_number IS NULL
        AND work_summary IS NOT NULL
    `)).rows;

    console.log(`Found ${rows.length} issue-cruncher rows to backfill`);
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const issueNumber = parseIssueNumber(row.workSummary ?? '');
      if (issueNumber == null) {
        skipped++;
        continue;
      }
      await db.query('UPDATE jobs SET gh_issue_number = $1 WHERE id = $2', [issueNumber, row.id]);
      updated++;
      console.log(`[${row.id}] -> #${issueNumber}`);
    }

    console.log(`\nDone. updated=${updated} skipped=${skipped}`);
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
