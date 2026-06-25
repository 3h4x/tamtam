import { join } from 'path';
import { homedir } from 'os';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getSettings } from '@/lib/shared/config';
import { listEnabledProjects } from '@/lib/shared/enabled-projects';

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
  if (s.endsWith('d')) return parseInt(s.slice(0, -1), 10) * 24 * 60;
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
      test_command: p.testCommand ?? null,
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
export async function writePriorityYaml(
  projName: string,
  _jobName: string | null,
  priority: string | null
): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const existing = rows[0] ?? null;
  if (!existing) return false;
  void db.update(schema.projects).set({ priority }).where(eq(schema.projects.name, projName)).execute().catch(e => console.error('[scheduling]', e));
  return true;
}

/**
 * Write a project field to the DB projects table. Returns false when the
 * project doesn't exist OR when the field name is not recognized.
 */
type ProjectUpdate = Parameters<ReturnType<typeof db.update<typeof schema.projects>>['set']>[0];
type FieldBuilder = (value: string | null) => ProjectUpdate;

const toBool = (v: string | null): boolean => v === '1' || v === 'true';

const FIELD_BUILDERS: Record<string, FieldBuilder> = {
  github: (v) => ({ github: v }),
  priority: (v) => ({ priority: v }),
  test_command: (v) => ({ testCommand: v }),
  test_cron_schedule: (v) => ({ testCronSchedule: v }),
  test_cron_enabled: (v) => ({ testCronEnabled: toBool(v) }),
  auto_commit_enabled: (v) => ({ autoCommitEnabled: toBool(v) }),
  auto_push_enabled: (v) => ({ autoPushEnabled: toBool(v) }),
  auto_pr_merge_enabled: (v) => ({ autoPrMergeEnabled: toBool(v) }),
  release_after_run: (v) => ({ releaseAfterRun: toBool(v) }),
  issue_auto_branch: (v) => ({ issueAutoBranch: toBool(v) }),
  tests_disabled: (v) => ({ testsDisabled: toBool(v) }),
  review_disabled: (v) => ({ reviewDisabled: toBool(v) }),
  review_prompt_addendum: (v) => ({ reviewPromptAddendum: v }),
  fix_prompt_addendum: (v) => ({ fixPromptAddendum: v }),
  review_prerequisite_command: (v) => ({ reviewPrerequisiteCommand: v }),
  website: (v) => ({ website: v }),
  qa_url: (v) => ({ qaUrl: v }),
  post_merge_watch_minutes: (v) => {
    const parsed = v === null ? 0 : Number.parseInt(v, 10);
    return { postMergeWatchMinutes: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 };
  },
  auto_revert_enabled: (v) => ({ autoRevertEnabled: toBool(v) }),
  dev_server_start_command: (v) => ({ devServerStartCommand: v }),
  dev_server_stop_command: (v) => ({ devServerStopCommand: v }),
  dev_server_ready_url: (v) => ({ devServerReadyUrl: v }),
  daily_spend_cap_usd: (v) => {
    const parsed = v === null ? null : Number.parseFloat(v);
    return { dailySpendCapUsd: parsed != null && Number.isFinite(parsed) ? parsed : null };
  },
  release_spend_cap_usd: (v) => {
    const parsed = v === null ? null : Number.parseFloat(v);
    return { releaseSpendCapUsd: parsed != null && Number.isFinite(parsed) ? parsed : null };
  },
};

export async function writeProjectFieldYaml(
  projName: string,
  fieldName: string,
  value: string | null
): Promise<boolean> {
  const builder = FIELD_BUILDERS[fieldName];
  if (!builder) return false;
  const rows = await db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  if (!rows[0]) return false;
  db.update(schema.projects)
    .set(builder(value))
    .where(eq(schema.projects.name, projName))
    .execute()
    .catch((e) => console.error('[scheduling]', e));
  return true;
}

export async function getProjectPipelinePrompts(projName: string): Promise<{
  reviewPromptAddendum: string | null;
  fixPromptAddendum: string | null;
  reviewPrerequisiteCommand: string | null;
}> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return { reviewPromptAddendum: null, fixPromptAddendum: null, reviewPrerequisiteCommand: null };
  return {
    reviewPromptAddendum: row.reviewPromptAddendum ?? null,
    fixPromptAddendum: row.fixPromptAddendum ?? null,
    reviewPrerequisiteCommand: row.reviewPrerequisiteCommand ?? null,
  };
}

export async function getProjectQaTarget(projName: string): Promise<{ qaUrl: string | null; website: string | null } | null> {
  const rows = await db
    .select({ qaUrl: schema.projects.qaUrl, website: schema.projects.website })
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    qaUrl: row.qaUrl?.trim() || null,
    website: row.website?.trim() || null,
  };
}

export function setProjectPushResult(projName: string, error: string | null): void {
  void db
    .update(schema.projects)
    .set({ lastPushError: error, lastPushAt: Date.now() / 1000 })
    .where(eq(schema.projects.name, projName))
    .execute()
    .catch(e => console.error('[scheduling]', e));
}

export async function getProjectPushResult(projName: string): Promise<{ lastPushError: string | null; lastPushAt: number | null } | null> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return { lastPushError: row.lastPushError ?? null, lastPushAt: row.lastPushAt ?? null };
}

export async function getProjectSoakConfig(projName: string): Promise<{
  postMergeWatchMinutes: number;
  autoRevertEnabled: boolean;
} | null> {
  const rows = await db
    .select({
      postMergeWatchMinutes: schema.projects.postMergeWatchMinutes,
      autoRevertEnabled: schema.projects.autoRevertEnabled,
    })
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    postMergeWatchMinutes: row.postMergeWatchMinutes ?? 0,
    autoRevertEnabled: !!row.autoRevertEnabled,
  };
}

export async function getProjectTestConfig(projName: string): Promise<{
  testCommand: string | null;
  quarantinedTests: string[];
  testCronEnabled: boolean;
  testCronSchedule: string | null;
  autoCommitEnabled: boolean;
  autoPushEnabled: boolean;
  autoPrMergeEnabled: boolean;
  releaseAfterRun: boolean;
  issueAutoBranch: boolean;
  testsDisabled: boolean;
  reviewDisabled: boolean;
  postMergeWatchMinutes: number;
  autoRevertEnabled: boolean;
} | null> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.name, projName))
    .limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    testCommand: row.testCommand ?? null,
    quarantinedTests: await getProjectQuarantinedTests(projName),
    testCronEnabled: !!row.testCronEnabled,
    testCronSchedule: row.testCronSchedule ?? null,
    autoCommitEnabled: row.autoCommitEnabled ?? false,
    autoPushEnabled: row.autoPushEnabled ?? false,
    autoPrMergeEnabled: row.autoPrMergeEnabled ?? false,
    releaseAfterRun: row.releaseAfterRun ?? false,
    issueAutoBranch: row.issueAutoBranch ?? true,
    testsDisabled: !!row.testsDisabled,
    reviewDisabled: !!row.reviewDisabled,
    postMergeWatchMinutes: row.postMergeWatchMinutes ?? 0,
    autoRevertEnabled: !!row.autoRevertEnabled,
  };
}

function parseQuarantinedTests(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  } catch {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean);
  }
}

export async function getProjectQuarantinedTests(projName: string): Promise<string[]> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, `project:${projName}:quarantined_tests`))
    .limit(1);
  return parseQuarantinedTests(rows[0]?.value);
}

export async function setProjectQuarantinedTests(projName: string, tests: string[]): Promise<void> {
  const key = `project:${projName}:quarantined_tests`;
  const value = JSON.stringify(tests);
  await db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    })
    .execute();
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
  // Resolve relative paths against the tamtam process working directory so
  // defaults like `./data/logs` land inside the project, not wherever the
  // command was launched from.
  if (p.startsWith('./') || p.startsWith('../') || (!p.startsWith('/') && p !== '')) {
    return join(/*turbopackIgnore: true*/ process.cwd(), p);
  }
  return p;
}
