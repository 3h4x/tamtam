import { loadSummaryFromLog, openDb } from './issue-run-summary-utils.mjs';

function main() {
  const db = openDb();
  const rows = db.prepare(`
    SELECT id, log_path AS logPath
    FROM jobs
    WHERE kind = 'run'
      AND gh_issue_number IS NOT NULL
      AND log_path IS NOT NULL
      AND finished_at IS NOT NULL
      AND (work_summary IS NULL OR work_summary = '')
  `).all();

  console.log(`Found ${rows.length} issue-run summaries to backfill`);
  let updated = 0;
  let missingLog = 0;
  let noSummary = 0;

  for (const row of rows) {
    let result;
    try {
      result = loadSummaryFromLog(row.logPath);
    } catch {
      missingLog++;
      continue;
    }
    if (result.status === 'missing-log') {
      missingLog++;
      continue;
    }
    if (!result.summary) {
      noSummary++;
      continue;
    }
    db.prepare('UPDATE jobs SET work_summary = ? WHERE id = ?').run(result.summary, row.id);
    updated++;
    console.log(`[${row.id}] ${result.summary.slice(0, 100)}${result.summary.length > 100 ? '…' : ''}`);
  }

  console.log(`\nDone. updated=${updated} missingLog=${missingLog} noSummary=${noSummary}`);
  db.close();
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
