import { join } from 'path';
import { homedir } from 'os';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { getSettings } from './config';

export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITY_ORDER)[number];

const DEFAULT_MULTIPLIERS: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 4,
  low: 8,
};

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseFrequency(freqStr: string): number {
  const s = String(freqStr).trim();
  if (s.endsWith('h')) return parseInt(s.slice(0, -1), 10) * 60;
  if (s.endsWith('m')) return parseInt(s.slice(0, -1), 10);
  return parseInt(s, 10);
}

export function getPriorityMultipliers(): Record<string, number> {
  return { ...DEFAULT_MULTIPLIERS };
}

export function effectiveFreqMin(
  priority: string,
  multipliers: Record<string, number>,
  baseFreqMin: number
): number {
  const mult = multipliers[priority] ?? DEFAULT_MULTIPLIERS[priority] ?? 4;
  return baseFreqMin * mult;
}

export function computeSchedule(
  tierIdx: number,
  baseFreqMin: number,
  effectiveFreqMinVal: number
): { minute: number; cycleHours: number; hourPhase: number } {
  const totalOffset = tierIdx * baseFreqMin;
  const cycleHours = Math.max(1, Math.ceil(effectiveFreqMinVal / 60));
  const minute = totalOffset % 60;
  const hourPhase = Math.floor(totalOffset / 60);
  return { minute, cycleHours, hourPhase };
}

export interface ProjectConfig {
  path: string;
  prompt: string;
  validate: boolean;
  persona: string[];
  project: string;
  scheduler: string | null;
  github: string | null;
  priority: string | null;
  test_command: string | null;
}

export interface ImproveConfig {
  projects: Record<string, ProjectConfig>;
  claudeBin: string;
  logDir: string;
  freqMin: number;
  daytime: boolean;
  weekends: boolean;
}

/**
 * Build config from DB settings + enabled projects.
 * Reads from DB settings + enabled projects table.
 */
export function getImproveConfig(): ImproveConfig {
  const settings = getSettings();

  // Read enabled projects from DB
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

  const claudeBin = expandHome(settings.claude_bin);
  const logDir = expandHome(settings.log_dir);
  const freqMin = parseFrequency(settings.frequency);

  return {
    projects,
    claudeBin,
    logDir,
    freqMin,
    daytime: settings.daytime,
    weekends: settings.weekends,
  };
}

export function resolveTargets(
  projectArg: string,
  projects: Record<string, ProjectConfig>
): string[] | null {
  if (projectArg in projects) return [projectArg];
  const matches = Object.entries(projects)
    .filter(([, cfg]) => cfg.project === projectArg)
    .map(([sid]) => sid);
  return matches.length > 0 ? matches : null;
}

/**
 * Write priority to the DB projects table.
 */
export function writePriorityYaml(
  projName: string,
  _jobName: string | null,
  priority: string | null
): boolean {
  const existing = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .get();
  if (!existing) return false;
  db.update(schema.projects)
    .set({ priority })
    .where(eq(schema.projects.name, projName))
    .run();
  return true;
}

/**
 * Write a project field to the DB projects table.
 */
export function writeProjectFieldYaml(
  projName: string,
  fieldName: string,
  value: string | null
): boolean {
  const existing = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .get();
  if (!existing) return false;
  if (fieldName === 'github') {
    db.update(schema.projects).set({ github: value }).where(eq(schema.projects.name, projName)).run();
  } else if (fieldName === 'priority') {
    db.update(schema.projects).set({ priority: value }).where(eq(schema.projects.name, projName)).run();
  }
  return true;
}

export function parseCronTime(cron: string): {
  minute: number;
  step: number;
  start: number;
  weekday: number | null;
} {
  const parts = cron.trim().split(/\s+/);
  const minuteStr = parts[0];
  const hourStr = parts[1];
  const dowStr = parts.length >= 5 ? parts[4] : '*';
  const minute = parseInt(minuteStr, 10);
  const weekday = dowStr !== '*' ? parseInt(dowStr, 10) : null;

  let step: number;
  let start: number;
  if (hourStr.startsWith('*/')) {
    step = parseInt(hourStr.slice(2), 10);
    start = 0;
  } else if (hourStr.includes('/')) {
    const [startStr, stepStr] = hourStr.split('/');
    step = parseInt(stepStr, 10);
    start = parseInt(startStr, 10);
  } else {
    step = 0;
    start = parseInt(hourStr, 10);
  }

  return { minute, step, start, weekday };
}

export function cronFiresStr(cron: string): string {
  try {
    const { minute, step, start, weekday } = parseCronTime(cron);
    if (weekday !== null) {
      const dow = DOW_NAMES[weekday % 7];
      return `${dow} ${String(start).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    if (step === 0) {
      return `daily ${String(start).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    if (step === 1) {
      return `every 1h :${String(minute).padStart(2, '0')}`;
    }
    return `every ${step}h +${start}h :${String(minute).padStart(2, '0')}`;
  } catch {
    return cron;
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}
