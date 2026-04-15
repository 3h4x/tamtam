import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import {
  getImproveConfig,
  getPriorityMultipliers,
  effectiveFreqMin,
  computeSchedule,
  parseCronTime,
  cronFiresStr,
  PRIORITY_ORDER,
  type ProjectConfig,
} from './scheduling';
import { fireTimesStr } from './fire-times';
import { launchctlInfo, plistPath, pausedPlistPath, type LaunchctlInfo } from './launchagent';
import { ghStatusLookup } from './gh-status';
import { lastRunLookup, type RunEntry } from './run-history';
import { gitChanges, isReviewed } from './git-utils';
import { exec } from './shell';

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
  ghStatus: Record<string, any>,
  changesMap: Record<string, number>,
  infoMap: Record<string, LaunchctlInfo>
): Promise<Record<string, any>> {
  const priority = cfg.priority;
  const effFreq = priority
    ? effectiveFreqMin(priority, multipliers, baseFreqMin)
    : baseFreqMin;

  let minute: number, cycleHours: number, hourPhase: number, firesAt: string;
  const staticCron = (cfg as any).cron;
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
  const ciFailedUrl = gh.ciFailedUrl ?? gh.ci_failed_url ?? null;

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
    priority,
    launchctl,
    fires_at: firesAt,
    sync,
    changes,
    reviewed,
    last_run: lastRun,
    last_run_ago: lastRunAgo,
    last_run_duration_s: lastRunDurationS,
    last_run_exit: lastRunExit,
    release_tag: releaseTag,
    ci,
    ci_failed_url: ciFailedUrl,
  };
}

// TTL cache
let _cache: { data: any; time: number } = { data: null, time: 0 };
const CACHE_TTL = 10;

export function clearProjectDataCache(): void {
  _cache = { data: null, time: 0 };
}

export async function fetchProjectData(): Promise<{
  projects: Record<string, any[]>;
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
    ghStatusLookup(projects).catch(() => ({} as Record<string, any>)),
  ]);

  const changesMap: Record<string, number> = {};
  for (const [sid, val] of changesResults) changesMap[sid] = val;

  const infoMap: Record<string, LaunchctlInfo> = {};
  for (const [sid, val] of infoResults) infoMap[sid] = val;

  // Group by project name
  const projectTasks: Record<string, any[]> = {};
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
