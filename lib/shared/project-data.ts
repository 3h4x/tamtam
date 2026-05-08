import { existsSync } from 'fs';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import {
  getImproveConfig,
  getPriorityMultipliers,
  effectiveFreqMin,
  computeSchedule,
  parseCronTime,
  cronFiresStr,
  PRIORITY_ORDER,
  type ProjectConfig,
} from '@/lib/scheduling/scheduling';
import { fireTimesStr } from '@/lib/scheduling/fire-times';
import { launchctlInfo, plistPath, pausedPlistPath, type LaunchctlInfo } from '@/lib/scheduling/launchagent';
import { ghStatusLookup, type GhStatusEntry } from './gh-status';
import { lastRunLookup, type RunEntry } from '@/lib/jobs/run-history';
import { gitChanges, isReviewed } from '@/lib/git/git-utils';
import { exec } from '@/lib/shared/shell';
import type { Task } from '@/lib/shared/types';

/**
 * Get enabled projects from the DB projects table.
 */
function getEnabledProjects(): Record<string, ProjectConfig> {
  const dbProjects = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.enabled, true))
    .all();

  const projects: Record<string, ProjectConfig> = {};
  for (const p of dbProjects) {
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
  const projects = getEnabledProjects();
  for (const cfg of Object.values(projects)) {
    if (cfg.project === projectName) return cfg.path;
  }
  return null;
}

function launchctlState(info: LaunchctlInfo, schedId: string): string {
  if (info.loaded && info.pid) return 'running';
  if (info.loaded) return 'loaded';
  if (existsSync(pausedPlistPath(schedId))) return 'paused';
  if (existsSync(plistPath(schedId))) return 'installed';
  return 'missing';
}

function syncOk(
  info: LaunchctlInfo,
  minute: number,
  cycleHours: number,
  hourPhase: number
): boolean | null {
  if (info.plistMinute === null) return null;
  const minOk = info.plistMinute === minute;
  const phaseOk = info.wrapperPhase !== null ? info.wrapperPhase === hourPhase : true;
  const cycleOk = info.wrapperCycle !== null ? info.wrapperCycle === cycleHours : true;
  return minOk && phaseOk && cycleOk;
}

function formatTimeAgo(isoDate: string): string {
  const d = (Date.now() - new Date(isoDate).getTime()) / 1000;
  if (d < 60) return '<1m';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
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
  infoMap: Record<string, LaunchctlInfo>
): Promise<Task> {
  const priority = cfg.priority;
  const effFreq = priority
    ? effectiveFreqMin(priority, multipliers, baseFreqMin)
    : baseFreqMin;

  let minute: number, cycleHours: number, hourPhase: number, firesAt: string;
  const staticCron = (cfg as ProjectConfig & { cron?: string }).cron;
  if (staticCron) {
    const parsed = parseCronTime(staticCron);
    minute = parsed.minute;
    cycleHours = parsed.step || 1;
    hourPhase = parsed.start;
    firesAt = cronFiresStr(staticCron);
  } else {
    const schedule = computeSchedule(tierIdx, baseFreqMin, effFreq);
    minute = schedule.minute;
    cycleHours = schedule.cycleHours;
    hourPhase = schedule.hourPhase;
    firesAt = fireTimesStr(hourPhase, cycleHours, minute);
  }

  const info = infoMap[schedId] ?? (await launchctlInfo(schedId));
  const launchctl = launchctlState(info, schedId);
  const sync = syncOk(info, minute, cycleHours, hourPhase);

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
  const unpushed = await (async () => {
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
  })();

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

  let githubUrl: string | null = null;
  if (cfg.github) {
    githubUrl = `https://github.com/${cfg.github}`;
  } else {
    const r = await exec('git', ['-C', cfg.path, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    if (r.exitCode === 0) {
      let url = r.stdout.trim();
      if (url.startsWith('git@github.com:')) {
        url = 'https://github.com/' + url.slice('git@github.com:'.length).replace(/\.git$/, '');
      } else {
        url = url.replace(/\.git$/, '');
      }
      githubUrl = url;
    }
  }

  return {
    id: schedId,
    project: projName,
    job: cfg.scheduler,
    path: cfg.path,
    github: githubUrl,
    priority: priority as Task['priority'],
    launchctl: launchctl as Task['launchctl'],
    fires_at: firesAt,
    sync,
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

// TTL cache
let _cache: { data: { projects: Record<string, Task[]>; priorities: readonly string[] } | null; time: number } = { data: null, time: 0 };
const CACHE_TTL = 10;

export function clearProjectDataCache(): void {
  _cache = { data: null, time: 0 };
}

export async function fetchProjectData(): Promise<{
  projects: Record<string, Task[]>;
  priorities: readonly string[];
}> {
  const now = Date.now() / 1000;
  if (_cache.data && now - _cache.time < CACHE_TTL) return _cache.data;

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

  // Parallel fetch: changes, launchctl info, gh status
  const [changesResults, infoResults, ghStatus] = await Promise.all([
    Promise.all(
      schedIds.map(async (sid) => {
        const c = await gitChanges(projects[sid].path);
        return [sid, c ?? 0] as const;
      })
    ),
    Promise.all(
      schedIds.map(async (sid) => {
        const info = await launchctlInfo(sid);
        return [sid, info] as const;
      })
    ),
    ghStatusLookup(projects).catch(() => ({} as Record<string, GhStatusEntry>)),
  ]);

  const changesMap = Object.fromEntries(changesResults) as Record<string, number>;
  const infoMap = Object.fromEntries(infoResults) as Record<string, LaunchctlInfo>;

  // Group by project name
  const projectTasks: Record<string, Task[]> = {};
  for (const [sid, cfg] of Object.entries(projects)) {
    const task = await assembleProject(
      sid, cfg, tierIdxMap[sid], baseFreqMin, multipliers,
      lastRuns, ghStatus, changesMap, infoMap
    );
    const projName = cfg.project;
    if (!projectTasks[projName]) projectTasks[projName] = [];
    projectTasks[projName].push(task);
  }

  const sorted = Object.fromEntries(
    Object.entries(projectTasks).sort(([a], [b]) => a.localeCompare(b))
  );

  const result = { projects: sorted, priorities: PRIORITY_ORDER };
  _cache = { data: result, time: now };
  return result;
}
