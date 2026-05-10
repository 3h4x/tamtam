import { loadSummaryFromLog, openDb } from './issue-run-summary-utils.mjs';

function main() {
  const db = openDb();
  const rows = db.prepare(`
    SELECT id, kind, gh_issue_number AS ghIssue, log_path AS logPath, finished_at AS finishedAt
    FROM jobs
    WHERE log_path IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 100
  `).all();

  let withSummary = 0;
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
    withSummary++;
    const tag = `${row.kind}${row.ghIssue ? ` #${row.ghIssue}` : ''}`;
    console.log(`\n=== [${row.id}] ${tag} (${result.summary.length} chars) ===`);
    console.log(result.summary.slice(0, 500) + (result.summary.length > 500 ? '…' : ''));
  }

  console.log(`\n\nTotal=${rows.length}  withSummary=${withSummary}  missingLog=${missingLog}  noSummary=${noSummary}`);
  db.close();
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
