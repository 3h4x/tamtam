#!/usr/bin/env node
// Inspect collected build metrics from `data/build-metrics.jsonl` without
// running another build. Default: last 10 builds, summary view.
//
// Usage:
//   pnpm build:history                  last 10 with deltas
//   pnpm build:history --limit 30       last 30
//   pnpm build:history --label foo      filter by TAMTAM_BUILD_LABEL
//   pnpm build:history --slow           show only builds > 60s
//   pnpm build:history --raw            dump full JSON

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const METRICS_PATH = resolve(REPO_ROOT, 'data/build-metrics.jsonl');

const args = process.argv.slice(2);
let limit = 10;
let labelFilter = null;
let slowOnly = false;
let raw = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') limit = Number.parseInt(args[++i], 10);
  else if (args[i] === '--label') labelFilter = args[++i];
  else if (args[i] === '--slow') slowOnly = true;
  else if (args[i] === '--raw') raw = true;
}

if (!existsSync(METRICS_PATH)) {
  console.log(`No build history yet. Run \`pnpm build\` to start collecting at:\n  ${METRICS_PATH}`);
  process.exit(0);
}

const lines = readFileSync(METRICS_PATH, 'utf-8').split('\n').filter(Boolean);
const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

let filtered = records;
if (labelFilter !== null) filtered = filtered.filter((r) => r.label === labelFilter);
if (slowOnly) filtered = filtered.filter((r) => r.wall_ms > 60_000);
const tail = filtered.slice(-limit);

if (raw) {
  for (const r of tail) console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

if (tail.length === 0) {
  console.log(`No builds match the filter (records=${records.length}).`);
  process.exit(0);
}

console.log(`build history (${tail.length} of ${records.length} total · file: data/build-metrics.jsonl)`);
console.log('');
const header = ['#', 'when', 'wall', 'turbopack', 'cpu peak', 'core sat', 'load pk', 'rss peak', 'worker', 'exit', 'label'];
const widths = [4, 20, 8, 10, 10, 9, 8, 9, 8, 6, 12];
const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
console.log(fmt(header));
console.log(fmt(widths.map((w) => '-'.repeat(w))));
for (let i = 0; i < tail.length; i++) {
  const r = tail[i];
  const idx = filtered.length - tail.length + i + 1;
  const turbopack = r.trace_summary?.run_turbopack_ms ? `${(r.trace_summary.run_turbopack_ms / 1000).toFixed(1)}s` : '—';
  const cpu = r.cpu ? `${r.cpu.peak_pct}%` : '—';
  const sat = r.cpu ? `${r.cpu.peak_core_saturation_pct}%` : '—';
  const rss = r.rss ? `${(r.rss.peak_mb / 1024).toFixed(2)}G` : '—';
  // Flag oversubscribed builds (peak load > cores) — their wall time is
  // inflated by host contention rather than anything in the config.
  const load = r.load ? `${r.load.peak_1m.toFixed(0)}${r.load.peak_oversubscription > 1 ? '⚠' : ''}` : '—';
  const worker = r.trace_summary?.use_build_worker ?? '—';
  console.log(fmt([
    `#${idx}`,
    r.ts.replace('T', ' ').slice(0, 19),
    `${(r.wall_ms / 1000).toFixed(1)}s`,
    turbopack,
    cpu,
    sat,
    load,
    rss,
    String(worker),
    r.exit_code ?? `sig:${r.signal}`,
    r.label ?? '—',
  ]));
}

// Aggregates for the filtered window.
const walls = tail.map((r) => r.wall_ms).filter(Boolean);
const turbo = tail.map((r) => r.trace_summary?.run_turbopack_ms).filter(Boolean);
const peakCpus = tail.map((r) => r.cpu?.peak_pct).filter(Boolean);
const med = (arr) => arr.length === 0 ? null : [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const avg = (arr) => arr.length === 0 ? null : Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);

console.log('');
console.log(`aggregates over the ${tail.length}-build window:`);
console.log(`  wall_ms     min=${Math.min(...walls)}  med=${med(walls)}  max=${Math.max(...walls)}  avg=${avg(walls)}`);
if (turbo.length > 0) {
  console.log(`  turbopack   min=${Math.min(...turbo)}  med=${med(turbo)}  max=${Math.max(...turbo)}  avg=${avg(turbo)}`);
}
if (peakCpus.length > 0) {
  console.log(`  cpu peak    min=${Math.min(...peakCpus)}%  med=${med(peakCpus)}%  max=${Math.max(...peakCpus)}%`);
}
