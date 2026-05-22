#!/usr/bin/env node
// Post-build NFT size guard.
//
// Walks `.next/server/**/*.nft.json` and asserts that no route's traced file
// list exceeds the limits below. NFT bloat is the symptom of an un-annotated
// dynamic `fs.*` call (or a missing entry in `next.config.ts`
// `outputFileTracingExcludes`) — both of which slow the build, balloon the
// `.next/` artifact, and previously hung the build at 471 GB virtual memory
// before we put protections in place.
//
// Exits non-zero with a clear report when a route exceeds the limit so the
// PR fails CI rather than the next operator wondering why their builds got
// slow again.

import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

// Tuned slightly above the current worst route post-fix (`config/projects`
// at ~356 KB / ~1500 files). Picked to leave headroom for normal growth
// while still catching the kind of regression that took us from ~1k files
// per route to 175k.
const MAX_NFT_BYTES = 1_500_000; // 1.5 MB JSON
const MAX_NFT_FILES = 8_000; // 8k traced files per route

const ROOT = resolve(process.argv[2] ?? '.next/server');

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.nft.json')) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(ROOT);
if (files.length === 0) {
  console.error(`[check-nft-sizes] no .nft.json files under ${ROOT} — has the build run?`);
  process.exit(2);
}

const violations = [];
const summary = [];
for (const path of files) {
  const size = statSync(path).size;
  let fileCount = 0;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    fileCount = Array.isArray(parsed.files) ? parsed.files.length : 0;
  } catch {
    // Malformed NFT — surface but don't fail the guard (Next may have written
    // a partial file mid-build for diagnostic purposes).
    fileCount = -1;
  }
  summary.push({ path, size, fileCount });
  if (size > MAX_NFT_BYTES || fileCount > MAX_NFT_FILES) {
    violations.push({ path, size, fileCount });
  }
}

summary.sort((a, b) => b.size - a.size);

console.log(`[check-nft-sizes] scanned ${summary.length} NFT files`);
console.log(`[check-nft-sizes] top 5 by size:`);
for (const s of summary.slice(0, 5)) {
  const rel = relative(process.cwd(), s.path);
  console.log(`  ${(s.size / 1024).toFixed(1).padStart(8)} KB · ${String(s.fileCount).padStart(6)} files · ${rel}`);
}

if (violations.length === 0) {
  console.log(`[check-nft-sizes] OK · all routes under ${MAX_NFT_BYTES / 1024 / 1024} MB / ${MAX_NFT_FILES} files`);
  process.exit(0);
}

console.error(`\n[check-nft-sizes] FAIL · ${violations.length} route(s) exceeded the NFT size/file limit:`);
for (const v of violations) {
  const rel = relative(process.cwd(), v.path);
  console.error(`  ${(v.size / 1024).toFixed(1)} KB · ${v.fileCount} files · ${rel}`);
}
console.error(`\nLikely cause: an un-annotated dynamic-path \`fs.*\` call inside one of the route's transitive deps.`);
console.error(`Fix: either add \`/*turbopackIgnore: true*/\` next to the dynamic arg at the call site, or extend`);
console.error(`     \`outputFileTracingExcludes\` in next.config.ts if the directory should never be traced.`);
console.error(`See: docs/PROFILING.md and the "Turbopack NFT comments" section in CLAUDE.md.`);
process.exit(1);
