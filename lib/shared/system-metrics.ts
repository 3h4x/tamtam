// Host resource sampler. Runs inside the TamTam process and records CPU /
// memory / load (and best-effort disk) once a minute so we can see — live in
// the Bridge and historically in `data/system-metrics.jsonl` — whether the
// box is being overloaded. Born out of the incident where a build + the fleet
// CPU-starved the host into a thrash with zero visibility.
//
// Design constraints (this runs in the critical server process):
//   - CPU / load / memory come from Node's `os` module: zero shell-outs, never
//     blocks, cross-platform. These are the overload signals that matter.
//   - Disk usage / IO are BEST-EFFORT via short, timeout-guarded shell-outs;
//     any failure leaves them null and never blocks the core sample.
//   - The whole sampler is wrapped so a sampling error can never crash boot.

import os from 'node:os';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exec } from '@/lib/shared/shell';

export interface SystemSample {
  /** Epoch milliseconds. */
  ts: number;
  /** Whole-host CPU utilization 0–100 (null on the very first sample — no
   *  delta to compute against yet). */
  cpuPct: number | null;
  cpuCount: number;
  load1: number;
  load5: number;
  load15: number;
  /** load1 / cpuCount. >1 means more runnable work than cores = oversubscribed
   *  (the signal that the box is being pushed too hard). */
  loadPerCore: number;
  memUsedMb: number;
  memTotalMb: number;
  memPct: number;
  /** Best-effort root-filesystem usage %. null if `df` unavailable. */
  diskUsedPct: number | null;
  /** Best-effort combined disk throughput MB/s. null if `iostat` unavailable. */
  diskIoMbS: number | null;
}

const RING_CAP = 180; // ~3h at one sample/min — enough for the Bridge live view
const SAMPLE_INTERVAL_MS = 60_000;
const FILE_MAX_LINES = 10_080; // ~7 days at one/min; trimmed on boot
const METRICS_FILE = join(process.cwd(), 'data', 'system-metrics.jsonl');

// Next.js duplicates modules across realms (instrumentation vs route handler),
// so the sampler's ring would be invisible to /api/stats/system if it were
// merely module-scoped. Pin on globalThis like the other cross-realm singletons
// (see CLAUDE.md "Singletons on globalThis").
interface SystemMetricsState {
  ring: SystemSample[];
  prevCpu: { idle: number; total: number } | null;
}
const STATE_KEY = '__tamtamSystemMetricsState';
function state(): SystemMetricsState {
  const g = globalThis as Record<string, unknown>;
  let s = g[STATE_KEY] as SystemMetricsState | undefined;
  if (!s) {
    s = { ring: [], prevCpu: null };
    g[STATE_KEY] = s;
  }
  return s;
}

function cpuTotals(): { idle: number; total: number; count: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, count: cpus.length };
}

/** CPU% from the delta vs the previous reading (null until we have two). */
function readCpuPct(): { cpuPct: number | null; count: number } {
  const now = cpuTotals();
  const s = state();
  let cpuPct: number | null = null;
  if (s.prevCpu) {
    const idleDelta = now.idle - s.prevCpu.idle;
    const totalDelta = now.total - s.prevCpu.total;
    if (totalDelta > 0) {
      cpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
    }
  }
  s.prevCpu = { idle: now.idle, total: now.total };
  return { cpuPct, count: now.count };
}

async function readDiskUsedPct(): Promise<number | null> {
  try {
    // `df -k .` → second line, "Capacity"/"Use%" column (e.g. `73%`). Works on
    // both macOS and Linux; we just grep the first percentage in the output.
    const r = await exec('df', ['-k', process.cwd()], { timeout: 3000 });
    if (r.exitCode !== 0) return null;
    const m = r.stdout.match(/(\d+)%/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

async function readDiskIoMbS(): Promise<number | null> {
  try {
    // `iostat -d -w 1 -c 2` (macOS) prints two samples 1s apart; the LAST
    // block is the recent rate. We sum the MB/s columns across disks. Strictly
    // best-effort + timeout-guarded so it can never hang the sampler.
    const r = await exec('iostat', ['-d', '-w', '1', '-c', '2'], { timeout: 4000 });
    if (r.exitCode !== 0) return null;
    const lines = r.stdout.trim().split('\n');
    // The last data line holds per-disk "KB/t tps MB/s" triples; sum every 3rd.
    const last = lines[lines.length - 1];
    const nums = (last.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    let mbs = 0;
    for (let i = 2; i < nums.length; i += 3) mbs += nums[i];
    return Math.round(mbs * 10) / 10;
  } catch {
    return null;
  }
}

/** Take one sample. CPU/load/mem are instant; disk is best-effort. */
export async function sampleSystemMetrics(): Promise<SystemSample> {
  const { cpuPct, count } = readCpuPct();
  const [load1, load5, load15] = os.loadavg();
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const usedMb = totalMb - freeMb;
  const [diskUsedPct, diskIoMbS] = await Promise.all([readDiskUsedPct(), readDiskIoMbS()]);
  return {
    ts: Date.now(),
    cpuPct,
    cpuCount: count,
    load1: Math.round(load1 * 100) / 100,
    load5: Math.round(load5 * 100) / 100,
    load15: Math.round(load15 * 100) / 100,
    loadPerCore: count > 0 ? Math.round((load1 / count) * 100) / 100 : 0,
    memUsedMb: usedMb,
    memTotalMb: totalMb,
    memPct: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0,
    diskUsedPct,
    diskIoMbS,
  };
}

function pushRing(sample: SystemSample): void {
  const { ring } = state();
  ring.push(sample);
  while (ring.length > RING_CAP) ring.shift();
}

async function persist(s: SystemSample): Promise<void> {
  try {
    await mkdir(/*turbopackIgnore: true*/ dirname(METRICS_FILE), { recursive: true });
    await appendFile(/*turbopackIgnore: true*/ METRICS_FILE, JSON.stringify(s) + '\n', 'utf8');
  } catch {
    /* persistence is best-effort — never let it break sampling */
  }
}

/** Trim the JSONL to the last FILE_MAX_LINES so it can't grow without bound. */
async function trimFileOnce(): Promise<void> {
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ METRICS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > FILE_MAX_LINES) {
      await writeFile(/*turbopackIgnore: true*/ METRICS_FILE, lines.slice(-FILE_MAX_LINES).join('\n') + '\n', 'utf8');
    }
    // Warm the ring with the most recent samples so the Bridge has history
    // immediately after a restart instead of waiting a minute for the first.
    for (const line of lines.slice(-RING_CAP)) {
      try { pushRing(JSON.parse(line) as SystemSample); } catch { /* skip bad line */ }
    }
  } catch {
    /* no file yet — fine */
  }
}

export function getCurrentSystemMetrics(): SystemSample | null {
  const { ring } = state();
  return ring.length ? ring[ring.length - 1] : null;
}

export function getRecentSystemMetrics(limit = RING_CAP): SystemSample[] {
  const { ring } = state();
  return limit >= ring.length ? [...ring] : ring.slice(ring.length - limit);
}

// Start-once guard: instrumentation can re-run across HMR / multiple imports;
// a globalThis flag keeps exactly one interval alive per process.
const SAMPLER_FLAG = '__tamtamSystemMetricsSampler';

export function startSystemMetricsSampler(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[SAMPLER_FLAG]) return;
  g[SAMPLER_FLAG] = true;
  void (async () => {
    await trimFileOnce();
    const tick = async () => {
      try {
        const s = await sampleSystemMetrics();
        pushRing(s);
        await persist(s);
      } catch (e) {
        console.error('[system-metrics] sample failed:', e);
      }
    };
    await tick(); // prime immediately (first cpuPct will be null)
    const id = setInterval(() => { void tick(); }, SAMPLE_INTERVAL_MS);
    // Don't keep the event loop alive solely for sampling.
    if (typeof id.unref === 'function') id.unref();
  })();
}
