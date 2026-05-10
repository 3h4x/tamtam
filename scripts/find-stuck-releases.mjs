#!/usr/bin/env node
// Scan the DB for release jobs that were finalized as "done" but whose chain
// stopped at a non-terminal step (test / fix / review / commit) without a
// commit/push/merge ever following. Prints one row per stuck release.
//
// Usage:
//   node scripts/find-stuck-releases.mjs           # report only
//   node scripts/find-stuck-releases.mjs --json    # JSON output
//
// Pair with the local /resume endpoint to actually revive a chosen release:
//   curl -X POST http://localhost:1337/api/projects/by-project/<proj>/release/<id>/resume

import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = process.env.TAMTAM_DB_PATH || join(process.cwd(), 'data', 'db', 'tamtam.db');
const NON_TERMINAL = new Set(['test', 'fix', 'review', 'commit']);
const PIPELINE_CHAIN_GAP_SEC = 60;

const db = new Database(DB_PATH, { readonly: true });

const releases = db.prepare(`
  SELECT id, project, started_at as startedAt, finished_at as finishedAt, exit_code as exitCode
  FROM jobs
  WHERE kind = 'release' AND finished_at IS NOT NULL AND exit_code = 0
  ORDER BY started_at DESC
  LIMIT 500
`).all();

const stuck = [];
for (const r of releases) {
  const children = db.prepare(`
    SELECT id, kind, started_at as startedAt, finished_at as finishedAt, exit_code as exitCode
    FROM jobs
    WHERE project = ? AND release_id = ? AND kind IN ('test','review','fix','commit','push','fix-push','pr-wait','mark-dod')
    ORDER BY started_at ASC
  `).all(r.project, r.id);
  if (children.length === 0) continue;
  // Walk the contiguous release chain. Later retry jobs can reuse release_id,
  // so once the chain breaks they must not redefine the terminal step.
  const chain = [];
  let edge = r.startedAt;
  for (const c of children) {
    if ((c.startedAt - edge) > PIPELINE_CHAIN_GAP_SEC) break;
    chain.push(c);
    edge = c.finishedAt ?? edge;
  }
  if (chain.length === 0) continue;
  const tail = chain[chain.length - 1].kind === 'mark-dod' && chain.length > 1
    ? chain[chain.length - 2]
    : chain[chain.length - 1];
  // The signature of "stuck": the LAST step is non-terminal and ended exit 0,
  // so the next step should have spawned but didn't. Earlier failures in the
  // chain are normal (test fails → fix → test passes), they don't disqualify.
  if (tail.exitCode !== 0) continue;
  if (NON_TERMINAL.has(tail.kind)) {
    stuck.push({
      release: r.id,
      project: r.project,
      startedAt: r.startedAt,
      stoppedAt: tail.kind,
      chain: chain.map((c) => `${c.kind}(${c.exitCode})`).join(' → '),
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(stuck, null, 2));
} else {
  console.log(`Found ${stuck.length} stuck release${stuck.length === 1 ? '' : 's'} (chain ended at non-terminal step):\n`);
  for (const s of stuck) {
    const ts = new Date(s.startedAt * 1000).toISOString();
    console.log(`  ${s.project.padEnd(20)} ${s.release}`);
    console.log(`    started: ${ts}`);
    console.log(`    stopped at: ${s.stoppedAt}`);
    console.log(`    chain: ${s.chain}`);
    console.log('');
  }
}
