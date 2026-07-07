import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import {
  getImproveConfig,
  getPriorityMultipliers,
  effectiveFreqMin,
  computeSchedule,
  cronFiresStr,
  PRIORITY_ORDER,
  type ProjectConfig,
} from '@/lib/scheduling/scheduling';
import { fireTimesStr } from '@/lib/scheduling/fire-times';
import { ghStatusLookup, type GhStatusEntry } from './gh-status';
import { listJobs } from '@/lib/jobs/storage';
import { gitChanges, isReviewed } from '@/lib/git/git-utils';
import { exec } from '@/lib/shared/shell';
import { mapWithConcurrency } from '@/lib/shared/concurrency';
import { formatTimeAgo } from '@/lib/shared/format';
import { cpus } from 'node:os';
import type { Task } from '@/lib/shared/types';

// Bound the per-project git fan-out. Each project's assembly runs several `git`
// shell-outs (status, rev-list, rev-parse, symbolic-ref, remote get-url), so an
// unbounded `Promise.all` over every project spawns 50-120 near-simultaneous
// subprocesses — a storm that saturates CPU / the event loop and stalls
// concurrent requests whose awaits land during the sweep (measured: an inbox
// poll spiking to ~2s while the sweep ran). Cap the number of projects assembled
// at once so peak subprocess pressure stays bounded regardless of fleet size;
// I/O still overlaps `SWEEP_CONCURRENCY`-ways so total wall-clock stays low.
const SWEEP_CONCURRENCY = Math.max(2, Math.min(8, (cpus()?.length ?? 4) - 2));

// "Most-recent run" projection used by the projects-list UI to render
// "last run X minutes ago — exit N" columns.
interface RunEntry {
  project: string;
  started: string;
  ended: string | null;
  durationS: number | null;
  exitCode: number | null;
}

function lastRunLookup(): Record<string, RunEntry> {
  const byProject: Record<string, RunEntry> = {};
  // listJobs() is unordered; track the latest startedAt per project.
  const latestStart: Record<string, number> = {};
  for (const j of listJobs()) {
    const start = j.startedAt;
    if (!start) continue;
    if (latestStart[j.project] !== undefined && latestStart[j.project] >= start) continue;
    latestStart[j.project] = start;
    byProject[j.project] = {
      project: j.project,
      started: new Date(start * 1000).toISOString(),
      ended: j.finishedAt != null ? new Date(j.finishedAt * 1000).toISOString() : null,
      durationS: j.finishedAt != null ? Math.max(0, Math.floor(j.finishedAt - start)) : null,
      exitCode: j.exitCode,
    };
  }
  return byProject;
}

/**
 * Get enabled projects from the DB projects table.
 */
function getEnabledProjects(): Record<string, ProjectConfig> {
  const projects: Record<string, ProjectConfig> = {};
  for (const p of listEnabledProjects()) {
    projects[p.name] = {
      path: p.path,
      prompt: '',
      validate: false,
      persona: [],
      project: p.name,
      scheduler: null,
      github: p.github ?? null,
      priority: p.priority ?? null,
      test_command: null,
    };
  }
  return projects;
}

export function resolveProjectPath(projectName: string): string | null {
  // 100+ call sites — skip the intermediate `getEnabledProjects()` Record
  // allocation and walk `listEnabledProjects()` directly with early exit.
  for (const p of listEnabledProjects()) {
    if (p.name === projectName) return p.path;
  }
  return null;
}


async function assembleProject(
  schedId: string,
  cfg: ProjectConfig,
  tierIdx: number,
  baseFreqMin: number,
  multipliers: Record<string, number>,
  lastRuns: Record<string, RunEntry>,
  ghStatus: Record<string, GhStatusEntry>,
  changesMap: Record<string, number>,
  pausedMap: Record<string, boolean>
): Promise<Task> {
  const priority = cfg.priority;
  const effFreq = priority
    ? effectiveFreqMin(priority, multipliers, baseFreqMin)
    : baseFreqMin;

  let firesAt: string;
  const staticCron = (cfg as ProjectConfig & { cron?: string }).cron;
  if (staticCron) {
    firesAt = cronFiresStr(staticCron);
  } else {
    const schedule = computeSchedule(tierIdx, baseFreqMin, effFreq);
    firesAt = fireTimesStr(schedule.hourPhase, schedule.cycleHours, schedule.minute);
  }

  const paused = pausedMap[schedId] ?? false;

  let changes = changesMap[schedId] ?? (await gitChanges(cfg.path)) ?? 0;
  const projName = cfg.project;
  const reviewed = changes > 0 ? await isReviewed(projName, cfg.path) : null;

  // Count commits not yet pushed. Primary source: `@{u}..HEAD` (commits the
  // local branch has that the upstream doesn't). When the branch has no
  // upstream configured (`fatal: no upstream configured`) the rev-list call
  // exits non-zero — fall back to comparing against `origin/<branch>` if it
  // exists, then against the default branch as a last resort. Without these
  // fallbacks the Push button silently disables on a branch that genuinely
  // has unpushed commits but is missing tracking config (e.g. after a
  // force-push that didn't set --set-upstream).
  const computeUnpushed = async (): Promise<number> => {
    const upstreamR = await exec('git', ['-C', cfg.path, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    if (upstreamR.exitCode === 0 && upstreamR.stdout.trim()) {
      return parseInt(upstreamR.stdout.trim(), 10) || 0;
    }
    // Need the current branch name for the remote-ref fallback.
    const branchR = await exec('git', ['-C', cfg.path, 'branch', '--show-current'], { timeout: 5000 });
    const currentBranch = branchR.stdout.trim();
    if (currentBranch) {
      // Does origin/<currentBranch> exist locally? If so, count against it.
      const remoteR = await exec(
        'git',
        ['-C', cfg.path, 'rev-parse', '--verify', `refs/remotes/origin/${currentBranch}`],
        { timeout: 5000 },
      );
      if (remoteR.exitCode === 0) {
        const aheadR = await exec(
          'git',
          ['-C', cfg.path, 'rev-list', '--count', `refs/remotes/origin/${currentBranch}..HEAD`],
          { timeout: 5000 },
        );
        if (aheadR.exitCode === 0 && aheadR.stdout.trim()) {
          return parseInt(aheadR.stdout.trim(), 10) || 0;
        }
      }
    }
    // No upstream and no matching remote ref — treat commits ahead of the
    // default branch as unpushed so the user at least sees a count and an
    // enabled Push button. `pushCurrentBranch` already retries with
    // `--set-upstream` when needed, so a click here will publish the branch.
    const defaultR = await exec('git', ['-C', cfg.path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeout: 5000 });
    const defaultRef = defaultR.exitCode === 0 ? defaultR.stdout.trim() : '';
    if (defaultRef) {
      const fallbackR = await exec(
        'git',
        ['-C', cfg.path, 'rev-list', '--count', `${defaultRef}..HEAD`],
        { timeout: 5000 },
      );
      if (fallbackR.exitCode === 0 && fallbackR.stdout.trim()) {
        return parseInt(fallbackR.stdout.trim(), 10) || 0;
      }
    }
    return 0;
  };

  const computeGithubUrl = async (): Promise<string | null> => {
    if (cfg.github) return `https://github.com/${cfg.github}`;
    const r = await exec('git', ['-C', cfg.path, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    if (r.exitCode !== 0) return null;
    let url = r.stdout.trim();
    if (url.startsWith('git@github.com:')) {
      url = 'https://github.com/' + url.slice('git@github.com:'.length).replace(/\.git$/, '');
    } else {
      url = url.replace(/\.git$/, '');
    }
    return url;
  };

  const [unpushed, githubUrl] = await Promise.all([computeUnpushed(), computeGithubUrl()]);

  const run = lastRuns[schedId];
  let lastRun: string | null = null;
  let lastRunAgo: string | null = null;
  let lastRunDurationS: number | null = null;
  let lastRunExit: number | null = null;
  if (run) {
    lastRun = run.ended;
    lastRunDurationS = run.durationS;
    lastRunExit = run.exitCode;
    if (run.ended) lastRunAgo = formatTimeAgo(run.ended);
  }

  const gh = ghStatus[projName] ?? {};
  const releaseTag = gh.release ?? null;
  const ci = gh.ci ?? null;
  const ciFailedUrl = gh.ciFailedUrl ?? null;

  return {
    id: schedId,
    project: projName,
    job: cfg.scheduler,
    path: cfg.path,
    github: githubUrl,
    priority: priority as Task['priority'],
    paused,
    fires_at: firesAt,
    sync: null,
    changes,
    unpushed,
    reviewed,
    last_run: lastRun,
    last_run_ago: lastRunAgo,
    last_run_duration_s: lastRunDurationS,
    last_run_exit: lastRunExit,
    release_tag: releaseTag,
    ci: ci as Task['ci'],
    ci_failed_url: ciFailedUrl,
  };
}

// TTL cache + single-flight refresh. The git+gh sweep is normally ~500ms but
// balloons under host/git contention (every agent run does git ops on the same
// repos). Without a single-flight guard, every concurrent request that finds the
// cache expired launches its OWN full sweep (dozens of git shell-outs) — a
// thundering herd that saturates CPU and the DB pool and turns slow requests
// into 500s. We dedup the refresh and serve stale-while-revalidate so a request
// never blocks on (or fails from) a slow rebuild.
type ProjectData = { projects: Record<string, Task[]>; priorities: readonly string[] };
let _cache: { data: ProjectData | null; time: number } = { data: null, time: 0 };
let _inflight: { promise: Promise<ProjectData | null>; generation: number } | null = null;
let _cacheGeneration = 0;
const CACHE_TTL = 10;

export function clearProjectDataCache(): void {
  _cache = { data: null, time: 0 };
  _cacheGeneration += 1;
  _inflight = null;
}

export async function fetchProjectData(): Promise<ProjectData> {
  const now = Date.now() / 1000;
  if (_cache.data && now - _cache.time < CACHE_TTL) return _cache.data;

  // At most one background refresh in flight (single-flight). On failure, keep
  // the stale cache rather than propagating the error to callers.
  if (!_inflight || _inflight.generation !== _cacheGeneration) {
    const generation = _cacheGeneration;
    const promise = _computeProjectData()
      .then((result) => {
        if (generation === _cacheGeneration) {
          _cache = { data: result, time: Date.now() / 1000 };
        }
        return result;
      })
      .catch((err) => { console.error('[project-data] refresh failed:', err); return _cache.data; })
      .finally(() => {
        if (_inflight?.promise === promise) _inflight = null;
      });
    _inflight = { promise, generation };
  }
  // Serve stale immediately if we have anything; only the cold first call awaits.
  if (_cache.data) return _cache.data;
  return (await _inflight.promise) ?? { projects: {}, priorities: PRIORITY_ORDER };
}

async function _computeProjectData(): Promise<ProjectData> {
  const projects = getEnabledProjects();
  const { freqMin: baseFreqMin } = getImproveConfig();
  const tierCounters: Record<string, number> = {};
  const tierIdxMap: Record<string, number> = {};
  for (const schedId of Object.keys(projects)) {
    const pri = projects[schedId].priority ?? 'none';
    tierIdxMap[schedId] = tierCounters[pri] ?? 0;
    tierCounters[pri] = (tierCounters[pri] ?? 0) + 1;
  }

  const multipliers = getPriorityMultipliers();
  const lastRuns = lastRunLookup();
  const schedIds = Object.keys(projects);

  // Parallel fetch: changes + gh status. Paused state is read from the
  // enabled-projects cache and joined locally (no extra DB round-trip). The
  // per-project `git status` calls are bounded so they don't add to the
  // subprocess storm alongside the assembly phase below.
  const [changesResults, ghStatus] = await Promise.all([
    mapWithConcurrency(schedIds, SWEEP_CONCURRENCY, async (sid) => {
      const c = await gitChanges(projects[sid].path);
      return [sid, c ?? 0] as const;
    }),
    ghStatusLookup(projects).catch(() => ({} as Record<string, GhStatusEntry>)),
  ]);

  const changesMap = Object.fromEntries(changesResults) as Record<string, number>;
  const pausedMap: Record<string, boolean> = {};
  for (const p of listEnabledProjects()) pausedMap[p.name] = !!p.paused;

  // Each `assembleProject` runs 4-6 `git` shell-outs (rev-list, rev-parse,
  // symbolic-ref, remote get-url). Running them fully concurrently across every
  // project is what produced the subprocess storm; `mapWithConcurrency` caps the
  // fan-out to `SWEEP_CONCURRENCY` projects at a time so I/O still overlaps but
  // peak subprocess pressure stays bounded and doesn't stall concurrent requests.
  const projectTasks: Record<string, Task[]> = {};
  const assembled = await mapWithConcurrency(
    Object.entries(projects),
    SWEEP_CONCURRENCY,
    async ([sid, cfg]) => {
      const task = await assembleProject(
        sid, cfg, tierIdxMap[sid], baseFreqMin, multipliers,
        lastRuns, ghStatus, changesMap, pausedMap,
      );
      return { projName: cfg.project, task };
    },
  );
  for (const { projName, task } of assembled) {
    if (!projectTasks[projName]) projectTasks[projName] = [];
    projectTasks[projName].push(task);
  }

  const sorted = Object.fromEntries(
    Object.entries(projectTasks).sort(([a], [b]) => a.localeCompare(b))
  );

  return { projects: sorted, priorities: PRIORITY_ORDER };
}
