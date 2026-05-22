#!/usr/bin/env node
// Post-build patch for the instrumentation NFT.
//
// `outputFileTracingExcludes` in `next.config.ts` is a page/route-keyed map
// — Next applies it by walking `entryNameFilesMap` (chunk trace entries),
// which only contains app/page and pages/api routes. `instrumentation.js`
// is not in that map, so the excludes never apply and NFT ends up listing
// every file under `data/workflow-data/` (~148k) and `data/logs/` (~28k)
// in `instrumentation.js.nft.json` — pure runtime state, never wanted in
// the deploy bundle.
//
// Strip them after NFT has written its output. The data directories are
// recreated on first run when the workflow runtime / job-storage code
// touches them.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve('.next/server/instrumentation.js.nft.json');

// Patterns that must NOT appear in the shipped instrumentation NFT.
// Keep aligned with `outputFileTracingExcludes` in next.config.ts so
// "where does runtime state live" stays single-sourced.
const RUNTIME_DATA_RE = /(?:^|\/)data\/(?:workflow-data|logs|attachments|dev-servers|db)\//;
const RUNTIME_DB_RE = /(?:^|\/)data\/[^/]+\.(?:db|db-shm|db-wal|sql|sql-shm|sql-wal)$/;

let raw;
try {
  raw = readFileSync(TARGET, 'utf-8');
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log(`[strip-runtime-data] ${TARGET} not present — skipping (no instrumentation hook?)`);
    process.exit(0);
  }
  throw err;
}

const sizeBefore = statSync(TARGET).size;
const parsed = JSON.parse(raw);
const filesBefore = Array.isArray(parsed.files) ? parsed.files.length : 0;
parsed.files = (parsed.files ?? []).filter((f) => {
  return !(RUNTIME_DATA_RE.test(f) || RUNTIME_DB_RE.test(f));
});
const filesAfter = parsed.files.length;
writeFileSync(TARGET, JSON.stringify(parsed));
const sizeAfter = statSync(TARGET).size;

const stripped = filesBefore - filesAfter;
if (stripped === 0) {
  console.log(`[strip-runtime-data] OK · no runtime data entries in instrumentation NFT (${filesAfter} files, ${(sizeAfter / 1024).toFixed(1)} KB)`);
} else {
  console.log(
    `[strip-runtime-data] stripped ${stripped} runtime data files from instrumentation NFT · ` +
    `${(sizeBefore / 1024 / 1024).toFixed(2)} MB → ${(sizeAfter / 1024).toFixed(1)} KB · ` +
    `${filesBefore} → ${filesAfter} files`
  );
}
