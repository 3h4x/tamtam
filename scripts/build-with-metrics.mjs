#!/usr/bin/env node
// Build wrapper: runs the full build pipeline (prebuild → next build →
// postbuild) and persists per-phase wall-clock timings + cpu/rss samples
// + a snapshot of `.next/trace`. Every build appends a one-line JSON
// record to `data/build-metrics.jsonl` and snapshots the trace to
// `data/traces/<ts>-trace.json`.
//
// This wrapper owns ALL phases so we can attribute time to each step:
//   - prebuild  → scripts/gen-workflow-graph.mjs
//   - build     → next build (the long one)
//   - postbuild → strip-runtime-data + check-nft-sizes
//
// package.json points `pnpm build` at this wrapper directly so the phases run
// once and can be timed in one process.
//
// Tune via env:
//   TAMTAM_BUILD_METRICS_OFF=1   disable the live cpu/rss sampler
//   TAMTAM_BUILD_LABEL=foo       tag this build run for later filtering
//   TAMTAM_BUILD_SKIP_PRE=1      skip prebuild step (already ran)
//   TAMTAM_BUILD_SKIP_POST=1     skip postbuild step
//   TAMTAM_BUILD_TURBO_TRACE=1   run with NEXT_TURBOPACK_TRACING for
//                                deep turbopack profiling (3+ GB trace)

import { spawn, execFileSync } from 'node:child_process';
import { cpus, totalmem, freemem, loadavg } from 'node:os';
import { existsSync, mkdirSync, copyFileSync, appendFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Guard against being imported elsewhere — a stray `import()` from a test
// or smoke check would otherwise spawn a real `next build` immediately.
const IS_CLI = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

const SAMPLE_INTERVAL_MS = 2000;
const CPU_COUNT = cpus().length;
const TOTAL_RAM_GB = totalmem() / (1024 ** 3);
const REPO_ROOT = new URL('..', import.meta.url).pathname;
const METRICS_PATH = resolve(REPO_ROOT, 'data/build-metrics.jsonl');
const TRACES_DIR = resolve(REPO_ROOT, 'data/traces');

const skipMetrics = process.env.TAMTAM_BUILD_METRICS_OFF === '1';
const skipPre = process.env.TAMTAM_BUILD_SKIP_PRE === '1';
const skipPost = process.env.TAMTAM_BUILD_SKIP_POST === '1';
const turboTrace = process.env.TAMTAM_BUILD_TURBO_TRACE === '1';
const label = process.env.TAMTAM_BUILD_LABEL ?? null;

// Bundler selection + output dir. TamTam's build defaults to webpack
// (`next build --webpack`); set `TAMTAM_BUILD_BUNDLER=turbopack` to opt back
// into Next 16's turbopack build. Output goes to the live `.next` by default;
// set TAMTAM_DIST_DIR (e.g. `.next-webpack-test`) for an isolated A/B build
// that never clobbers the live `.next`. The chosen dir is exported to the
// build child so next.config's env-driven `distDir` lands there.
const bundler = process.env.TAMTAM_BUILD_BUNDLER === 'turbopack' ? 'turbopack' : 'webpack';
const distDir = process.env.TAMTAM_DIST_DIR || '.next';
const NEXT_TRACE = resolve(REPO_ROOT, distDir, 'trace');

if (!IS_CLI) process.exit(0);

const require = createRequire(import.meta.url);

// Refuse to start if another `next build` is already in flight. Two builds
// sharing one `.next/` directory don't queue — they CLOBBER each other:
// Next's `.next/lock` makes the loser hard-fail (~2s `exit=1`), and a
// concurrent clean / `rm -rf .next` (rebuild's smoke-recovery) yanks temp
// manifests out from under the winner mid-write (`ENOENT _buildManifest
// .js.tmp...`). Both wreck the build AND the metrics/trace record. Fail
// fast with a clear message instead of producing a confusing partial run.
// Override with TAMTAM_BUILD_ALLOW_CONCURRENT=1 if you really mean it.
function otherBuildPids() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf-8' });
    const self = process.pid;
    const pids = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const cmd = m[2];
      if (pid === self) continue;
      // The actual compiler process: `next/dist/bin/next build`.
      if (/node\b.*\/next\/dist\/bin\/next\b.*\bbuild\b/.test(cmd)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}
if (process.env.TAMTAM_BUILD_ALLOW_CONCURRENT !== '1') {
  const others = otherBuildPids();
  if (others.length > 0) {
    console.error(
      `[build-metrics] ✗ another \`next build\` is already running (pid ${others.join(', ')}). ` +
      `Two builds share one .next/ and clobber each other — refusing to start. ` +
      `Wait for it to finish (e.g. \`pnpm rebuild\`), or set TAMTAM_BUILD_ALLOW_CONCURRENT=1 to override.`
    );
    process.exit(1);
  }
}

console.log(`[build-metrics] CPUs=${CPU_COUNT} · RAM=${TOTAL_RAM_GB.toFixed(0)} GB · bundler=${bundler} · dist=${distDir} · metrics→ data/build-metrics.jsonl${label ? ` · label=${label}` : ''}`);
if (distDir !== '.next') {
  console.log(`[build-metrics] isolated build into ${distDir} (live .next untouched)`);
}

// Oversubscription is the dominant driver of build-time variance on this
// box: history shows the SAME codebase compile in ~295s at 88% core
// saturation but balloon to ~1100s once the 1-min load average climbs
// past the core count (the live TamTam server + scheduled agents +
// overlapping builds all contend for the same cores). `pnpm rebuild`
// pauses jobs to avoid this; a raw `pnpm build` does not. Warn loudly so
// the operator knows a slow build here is contention, not a regression.
// ── Host memory / swap / paging probes ───────────────────────────────
// macOS doesn't expose reliable per-process disk IO, so we track the host
// signals that actually explain a slow build: free RAM, swap pressure, and
// the page-in/page-out counters (paging = the disk IO that matters here).
function readSwapUsedMb() {
  try {
    // e.g. "total = 25600.00M  used = 24731.12M  free = 868.88M  (encrypted)"
    const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf-8' });
    const used = out.match(/used\s*=\s*([\d.]+)M/);
    const total = out.match(/total\s*=\s*([\d.]+)M/);
    return {
      usedMb: used ? Math.round(Number.parseFloat(used[1])) : null,
      totalMb: total ? Math.round(Number.parseFloat(total[1])) : null,
    };
  } catch {
    return { usedMb: null, totalMb: null };
  }
}
function readPaging() {
  try {
    // vm_stat reports cumulative pageins/pageouts in pages; convert to bytes.
    const out = execFileSync('vm_stat', { encoding: 'utf-8' });
    const pageSize = Number.parseInt(out.match(/page size of (\d+) bytes/)?.[1] ?? '4096', 10);
    const pageins = Number.parseInt(out.match(/Pageins:\s*(\d+)/)?.[1] ?? '0', 10);
    const pageouts = Number.parseInt(out.match(/Pageouts:\s*(\d+)/)?.[1] ?? '0', 10);
    return { pageins, pageouts, pageSize };
  } catch {
    return { pageins: 0, pageouts: 0, pageSize: 4096 };
  }
}

const startLoad1 = loadavg()[0];
const startSwap = readSwapUsedMb();
const startPaging = readPaging();
let maxSwapUsedMb = startSwap.usedMb ?? 0;
let minFreeMemMb = Math.round(freemem() / (1024 ** 2));
if (startLoad1 > CPU_COUNT) {
  console.warn(
    `[build-metrics] ⚠ load average ${startLoad1.toFixed(1)} exceeds ${CPU_COUNT} cores — ` +
    `machine is oversubscribed. Expect 2-3× slower turbopack compile. ` +
    `Prefer \`pnpm rebuild\` (pauses jobs) or wait for load to drop.`
  );
}

// ── Sampler (covers ALL child processes spawned during this run) ──────
let maxRssKb = 0;
let maxCpuPct = 0;
let cpuSamples = 0;
let cpuTotal = 0;
let maxLoad1 = startLoad1;
let loadTotal = 0;
let loadSamples = 0;
let currentChildPid = null;

function descendantPids(rootPid) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' });
    const byParent = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const ppid = Number.parseInt(m[2], 10);
      const arr = byParent.get(ppid) ?? [];
      arr.push(pid);
      byParent.set(ppid, arr);
    }
    const all = [rootPid];
    const queue = [rootPid];
    while (queue.length) {
      const next = queue.shift();
      for (const kid of byParent.get(next) ?? []) {
        all.push(kid);
        queue.push(kid);
      }
    }
    return all;
  } catch {
    return [rootPid];
  }
}

function samplePidStats(pids) {
  try {
    const out = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', pids.join(',')], { encoding: 'utf-8' });
    let cpu = 0;
    let rss = 0;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^([\d.]+)\s+(\d+)$/);
      if (!m) continue;
      cpu += Number.parseFloat(m[1]);
      rss += Number.parseInt(m[2], 10);
    }
    return { cpuPct: cpu, rssKb: rss };
  } catch {
    return null;
  }
}

let sampler = null;
if (!skipMetrics) {
  sampler = setInterval(() => {
    // Sample system load every tick (cheap, no child needed) so we can
    // attribute slow builds to host contention after the fact.
    const l1 = loadavg()[0];
    if (l1 > maxLoad1) maxLoad1 = l1;
    loadTotal += l1;
    loadSamples += 1;
    // Host memory/swap pressure (cheap; no child needed) — peak swap and the
    // low-water mark on free RAM are what explain a swap-thrashing build.
    const freeMb = Math.round(freemem() / (1024 ** 2));
    if (freeMb < minFreeMemMb) minFreeMemMb = freeMb;
    const sw = readSwapUsedMb();
    if (sw.usedMb !== null && sw.usedMb > maxSwapUsedMb) maxSwapUsedMb = sw.usedMb;
    if (currentChildPid === null) return;
    const stats = samplePidStats(descendantPids(currentChildPid));
    if (!stats) return;
    if (stats.rssKb > maxRssKb) maxRssKb = stats.rssKb;
    if (stats.cpuPct > maxCpuPct) maxCpuPct = stats.cpuPct;
    cpuTotal += stats.cpuPct;
    cpuSamples += 1;
  }, SAMPLE_INTERVAL_MS);
}

function runPhase(name, file, args = [], extraEnv = {}) {
  return new Promise((resolveP, rejectP) => {
    const phaseStart = Date.now();
    console.log(`\n[build-metrics] ▸ ${name} starting …`);
    const child = spawn(file, args, {
      env: { ...process.env, NODE_ENV: 'production', ...extraEnv },
      stdio: 'inherit',
    });
    currentChildPid = child.pid;
    child.on('close', (code, signal) => {
      currentChildPid = null;
      const ms = Date.now() - phaseStart;
      const status = signal ? `signal:${signal}` : `exit=${code}`;
      console.log(`[build-metrics] ▸ ${name} ${status} · ${(ms / 1000).toFixed(2)}s`);
      if (signal || (code !== 0 && code !== null)) {
        return rejectP({ name, code, signal, ms });
      }
      resolveP({ name, code, signal, ms });
    });
    child.on('error', (err) => {
      currentChildPid = null;
      rejectP({ name, error: err, ms: Date.now() - phaseStart });
    });
  });
}

function readTraceSpans(path) {
  try {
    const { readFileSync } = require('node:fs');
    const text = readFileSync(path, 'utf-8');
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) out.push(...parsed);
        else out.push(parsed);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return null;
  }
}

function summarizeTrace(spans) {
  if (!spans) return null;
  const byName = (n) => spans.find((s) => s.name === n);
  const nextBuild = byName('next-build');
  const turbopack = byName('run-turbopack');

  // Aggregate per-span-name total/count/max in ms (trace durations are
  // microseconds). This is what lets the analyze script answer
  // "which phase is the slowest" without re-parsing the trace file.
  const agg = new Map();
  for (const s of spans) {
    if (typeof s.duration !== 'number' || !s.name) continue;
    const cur = agg.get(s.name) ?? { name: s.name, total_ms: 0, count: 0, max_ms: 0 };
    const ms = Math.round(s.duration / 1000);
    cur.total_ms += ms;
    cur.count += 1;
    if (ms > cur.max_ms) cur.max_ms = ms;
    agg.set(s.name, cur);
  }
  const topSpans = [...agg.values()]
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 25);
  const namedPhase = (n) => {
    const a = agg.get(n);
    return a ? { total_ms: a.total_ms, count: a.count, max_ms: a.max_ms } : null;
  };
  return {
    next_build_ms: nextBuild?.duration ? Math.round(nextBuild.duration / 1000) : null,
    run_turbopack_ms: turbopack?.duration ? Math.round(turbopack.duration / 1000) : null,
    use_build_worker: nextBuild?.tags?.['use-build-worker'] ?? null,
    has_custom_webpack_config: nextBuild?.tags?.['has-custom-webpack-config'] ?? null,
    bundler: nextBuild?.tags?.['bundler'] ?? null,
    span_count: spans.length,
    phases: {
      compile_app:         namedPhase('compile-app'),
      compile_pages:       namedPhase('compile-pages'),
      static_generation:   namedPhase('static-generation'),
      collect_page_data:   namedPhase('collect-page-data'),
      is_page_static:      namedPhase('is-page-static'),
      check_page:          namedPhase('check-page'),
      next_export:         namedPhase('next-export'),
      page_static_check:   namedPhase('page-static-check'),
      build_traces:        namedPhase('build-traces'),
      next_trace_entrypoint_for_app_pages: namedPhase('next-trace-entrypoint-for-app-pages'),
      next_trace_entrypoint_for_pages_pages: namedPhase('next-trace-entrypoint-for-pages-pages'),
      tree_shaking:        namedPhase('tree-shaking'),
      modules:             namedPhase('modules'),
      chunks:              namedPhase('chunks'),
      hash:                namedPhase('hash'),
      emit:                namedPhase('emit'),
    },
    top_spans: topSpans,
  };
}

const overallStart = Date.now();
const phaseTimings = {};

async function main() {
  const nextBin = new URL('../node_modules/.bin/next', import.meta.url).pathname;
  const nodeBin = process.execPath;

  if (!skipPre) {
    const r = await runPhase('prebuild:gen-workflow-graph',
      nodeBin, [resolve(REPO_ROOT, 'scripts/gen-workflow-graph.mjs')]);
    phaseTimings.prebuild_gen_workflow_graph_ms = r.ms;
  }

  const buildEnv = {
    ...(turboTrace ? { NEXT_TURBOPACK_TRACING: '1' } : {}),
    // Only export the dist override when it differs from the default so a
    // normal turbopack build's invocation stays byte-identical to before.
    ...(distDir !== '.next' ? { TAMTAM_DIST_DIR: distDir } : {}),
    // The webpack build worker's JS heap exceeds V8's default ~4 GB cap and
    // dies with SIGABRT ("Ineffective mark-compacts near heap limit"),
    // taking the previous `.next` production build with it. Give every node
    // child headroom unless the caller already tuned NODE_OPTIONS.
    ...(process.env.NODE_OPTIONS?.includes('--max-old-space-size')
      ? {}
      : { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim() }),
  };
  const buildArgs = bundler === 'webpack' ? ['build', '--webpack'] : ['build'];
  const buildResult = await runPhase('next-build', nextBin, buildArgs, buildEnv);
  phaseTimings.next_build_ms = buildResult.ms;

  // Postbuild steps (strip-runtime-data, check-nft-sizes) hardcode `.next`;
  // for an isolated experimental build dir they'd touch the live `.next`, so
  // skip them when building elsewhere. They're output hygiene, not part of
  // the build-time comparison we care about here.
  if (distDir !== '.next' && !skipPost) {
    console.log(`[build-metrics] skipping postbuild steps (isolated dist ${distDir}, live .next untouched)`);
  }
  if (!skipPost && distDir === '.next') {
    const r1 = await runPhase('postbuild:strip-runtime-data',
      nodeBin, [resolve(REPO_ROOT, 'scripts/strip-runtime-data-from-nft.mjs')]);
    phaseTimings.postbuild_strip_runtime_data_ms = r1.ms;
    const r2 = await runPhase('postbuild:check-nft-sizes',
      nodeBin, [resolve(REPO_ROOT, 'scripts/check-nft-sizes.mjs')]);
    phaseTimings.postbuild_check_nft_sizes_ms = r2.ms;
  }
}

async function persist(exitCode) {
  if (sampler) clearInterval(sampler);
  const elapsedMs = Date.now() - overallStart;
  const peakRssMb = Math.round(maxRssKb / 1024);
  const peakCpuPct = Math.round(maxCpuPct);
  const avgCpu = cpuSamples > 0 ? Math.round(cpuTotal / cpuSamples) : 0;
  const peakCoreSat = (maxCpuPct / (CPU_COUNT * 100)) * 100;

  let tracePath = null;
  let traceSummary = null;
  if (existsSync(NEXT_TRACE)) {
    try {
      mkdirSync(TRACES_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      tracePath = resolve(TRACES_DIR, `${ts}-trace.json`);
      copyFileSync(NEXT_TRACE, tracePath);
      copyFileSync(NEXT_TRACE, resolve(TRACES_DIR, 'latest.json'));
      traceSummary = summarizeTrace(readTraceSpans(NEXT_TRACE));
    } catch (err) {
      console.warn('[build-metrics] failed to snapshot trace:', err.message);
    }
  }

  const record = {
    ts: new Date().toISOString(),
    label,
    exit_code: exitCode,
    wall_ms: elapsedMs,
    phase_timings_ms: phaseTimings,
    cpu: skipMetrics ? null : {
      peak_pct: peakCpuPct,
      peak_core_saturation_pct: Math.round(peakCoreSat),
      avg_pct: avgCpu,
      samples: cpuSamples,
      sample_interval_ms: SAMPLE_INTERVAL_MS,
    },
    rss: skipMetrics ? null : {
      peak_mb: peakRssMb,
      peak_pct_of_total: Math.round((peakRssMb / 1024 / TOTAL_RAM_GB) * 100),
    },
    memory: skipMetrics ? null : {
      // Host free-RAM low-water mark during the build. A near-zero floor means
      // the build was starved of RAM and pushed the host into swap.
      min_free_mb: minFreeMemMb,
      min_free_pct_of_total: Math.round((minFreeMemMb / 1024 / TOTAL_RAM_GB) * 100),
    },
    swap: skipMetrics ? null : {
      total_mb: startSwap.totalMb,
      start_used_mb: startSwap.usedMb,
      peak_used_mb: maxSwapUsedMb,
      // >0 means the build added swap pressure on top of what was already used.
      delta_used_mb: startSwap.usedMb !== null ? maxSwapUsedMb - startSwap.usedMb : null,
    },
    io: skipMetrics ? null : (() => {
      // Paging delta over the build = the disk IO that actually matters for
      // build speed (RAM ↔ swap traffic). Per-process disk IO isn't reliably
      // available on macOS, so host paging is the proxy.
      const endPaging = readPaging();
      const ps = endPaging.pageSize;
      return {
        pageins_mb: Math.round(((endPaging.pageins - startPaging.pageins) * ps) / (1024 ** 2)),
        pageouts_mb: Math.round(((endPaging.pageouts - startPaging.pageouts) * ps) / (1024 ** 2)),
      };
    })(),
    host: { cpu_count: CPU_COUNT, total_ram_gb: Math.round(TOTAL_RAM_GB) },
    load: skipMetrics ? null : {
      start_1m: Math.round(startLoad1 * 100) / 100,
      peak_1m: Math.round(maxLoad1 * 100) / 100,
      avg_1m: loadSamples > 0 ? Math.round((loadTotal / loadSamples) * 100) / 100 : null,
      // >1 means demand exceeded core count for at least part of the build —
      // the build was CPU-starved and the wall time is inflated accordingly.
      peak_oversubscription: Math.round((maxLoad1 / CPU_COUNT) * 100) / 100,
    },
    // Which bundler produced this build and where it landed — lets the
    // history compare turbopack vs webpack runs without guessing.
    bundler,
    dist_dir: distDir,
    next_size_mb: existsSync(resolve(REPO_ROOT, distDir, 'server'))
      ? Math.round(statSync(resolve(REPO_ROOT, distDir, 'server')).size / 1024 / 1024) || null
      : null,
    trace_path: tracePath,
    trace_summary: traceSummary,
  };

  try {
    mkdirSync(resolve(REPO_ROOT, 'data'), { recursive: true });
    appendFileSync(METRICS_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('[build-metrics] failed to persist metrics:', err.message);
  }

  console.log('');
  console.log(`[build-metrics] === SUMMARY ===`);
  console.log(`[build-metrics] wall=${(elapsedMs / 1000).toFixed(1)}s · exit=${exitCode}`);
  for (const [k, v] of Object.entries(phaseTimings)) {
    const pct = ((v / elapsedMs) * 100).toFixed(1);
    console.log(`[build-metrics]   ${k.padEnd(40)} ${(v / 1000).toFixed(2)}s (${pct}%)`);
  }
  if (!skipMetrics) {
    console.log(`[build-metrics] cpu peak=${peakCpuPct}% (${Math.round(peakCoreSat)}% of ${CPU_COUNT}-core capacity) · avg=${avgCpu}%`);
    console.log(`[build-metrics] rss peak=${(peakRssMb / 1024).toFixed(2)} GB (${Math.round((peakRssMb / 1024 / TOTAL_RAM_GB) * 100)}% of ${TOTAL_RAM_GB.toFixed(0)} GB)`);
    const oversub = maxLoad1 / CPU_COUNT;
    const loadFlag = oversub > 1 ? ` ⚠ ${oversub.toFixed(1)}× oversubscribed — wall time inflated by host contention` : '';
    console.log(`[build-metrics] load 1m start=${startLoad1.toFixed(1)} peak=${maxLoad1.toFixed(1)} avg=${loadSamples > 0 ? (loadTotal / loadSamples).toFixed(1) : '?'} (${CPU_COUNT} cores)${loadFlag}`);
    const swapDelta = startSwap.usedMb !== null ? maxSwapUsedMb - startSwap.usedMb : null;
    const memFlag = minFreeMemMb < 1024 ? ' ⚠ host nearly out of RAM — build pushed into swap' : '';
    console.log(`[build-metrics] mem free floor=${(minFreeMemMb / 1024).toFixed(2)} GB · swap used start=${startSwap.usedMb ?? '?'}MB peak=${maxSwapUsedMb}MB${swapDelta !== null ? ` (+${swapDelta}MB)` : ''}${memFlag}`);
    const endPaging = readPaging();
    const piMb = Math.round(((endPaging.pageins - startPaging.pageins) * endPaging.pageSize) / (1024 ** 2));
    const poMb = Math.round(((endPaging.pageouts - startPaging.pageouts) * endPaging.pageSize) / (1024 ** 2));
    console.log(`[build-metrics] paging IO: pageins=${piMb}MB · pageouts=${poMb}MB (RAM↔swap traffic during build)`);
  }
  if (traceSummary) {
    console.log(`[build-metrics] trace: next-build=${traceSummary.next_build_ms}ms · run-turbopack=${traceSummary.run_turbopack_ms}ms · use-build-worker=${traceSummary.use_build_worker}`);
    const topFive = (traceSummary.top_spans ?? []).slice(0, 5);
    if (topFive.length) {
      console.log(`[build-metrics] top spans (by total time):`);
      for (const s of topFive) {
        console.log(`[build-metrics]   ${s.name.padEnd(40)} total=${(s.total_ms / 1000).toFixed(2)}s · count=${s.count} · max=${(s.max_ms / 1000).toFixed(2)}s`);
      }
    }
  }
  console.log(`[build-metrics] appended → ${METRICS_PATH.replace(REPO_ROOT, '')}${tracePath ? ` · trace → ${tracePath.replace(REPO_ROOT, '')}` : ''}`);
  console.log(`[build-metrics] inspect history: pnpm build:history`);
}

main()
  .then(async () => { await persist(0); process.exit(0); })
  .catch(async (err) => {
    console.error('[build-metrics] phase failed:', err);
    await persist(err?.code ?? 1);
    process.exit(err?.code ?? 1);
  });
