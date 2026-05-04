import { getJob, updateJob } from '@/lib/jobs/storage';
import type { JobData } from '@/lib/jobs/types';
import { getSettings } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { BOARD_STATUSES, deriveBoardTransition, type BoardStatus, type BoardSyncPhase } from './project-board-status';

const BOARD_FIELD_NAME = 'TamTam Status';
const BOARD_META_KEY = 'githubBoard';

type BoardOptionIds = Partial<Record<BoardStatus, string>>;

interface StoredBoardMeta {
  itemId?: string;
  title?: string;
  branch?: string;
  activities?: Array<{ key: string; line: string }>;
}

interface BoardSettingsSnapshot {
  enabled: boolean;
  owner: string;
  title: string;
  projectNumber: string;
  projectId: string;
  statusFieldId: string;
  optionIds: BoardOptionIds;
}

export interface EnsureBoardResult {
  owner: string;
  title: string;
  projectNumber: string;
  projectId: string;
  statusFieldId: string;
  optionIds: Record<BoardStatus, string>;
}

interface SyncJobToProjectBoardOptions {
  requireConfigured?: boolean;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getBoardMeta(job: JobData): StoredBoardMeta {
  const meta = parseJsonObject(job.contextMeta);
  const raw = meta[BOARD_META_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as StoredBoardMeta : {};
}

function setBoardMeta(job: JobData, boardMeta: StoredBoardMeta): void {
  const meta = parseJsonObject(job.contextMeta);
  meta[BOARD_META_KEY] = boardMeta;
  job.contextMeta = JSON.stringify(meta);
  updateJob(job);
}

function boardSettingsSnapshot(overrides?: Partial<BoardSettingsSnapshot>): BoardSettingsSnapshot {
  const settings = getSettings();
  const owner = (
    overrides?.owner ??
    settings.github_board_project_owner ??
    settings.github_owner ??
    ''
  ).trim();
  const title = (
    overrides?.title ??
    settings.github_board_project_title ??
    'TamTam'
  ).trim() || 'TamTam';
  return {
    enabled: overrides?.enabled ?? settings.github_board_sync_enabled,
    owner,
    title,
    projectNumber: overrides?.projectNumber ?? settings.github_board_project_number,
    projectId: overrides?.projectId ?? settings.github_board_project_id,
    statusFieldId: overrides?.statusFieldId ?? settings.github_board_status_field_id,
    optionIds: overrides?.optionIds ?? settings.github_board_status_option_ids,
  };
}

function boardSettingsError(settings: BoardSettingsSnapshot): string | null {
  if (!settings.enabled) return 'GitHub board sync is disabled.';
  if (!settings.owner) return 'GitHub board sync requires a GitHub owner.';
  if (!settings.projectNumber || !settings.projectId || !settings.statusFieldId) {
    return 'GitHub board sync is not fully configured yet.';
  }
  if (BOARD_STATUSES.some((status) => !settings.optionIds[status])) {
    return 'GitHub board sync is missing one or more board status options.';
  }
  return null;
}

function hasBoardSyncConfigured(settings: BoardSettingsSnapshot): settings is BoardSettingsSnapshot & {
  owner: string;
  projectNumber: string;
  projectId: string;
  statusFieldId: string;
} {
  return !!(
    settings.enabled &&
    settings.owner &&
    settings.projectNumber &&
    settings.projectId &&
    settings.statusFieldId &&
    BOARD_STATUSES.every((status) => !!settings.optionIds[status])
  );
}

function maybeArrayFromUnknown(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      const found = maybeArrayFromUnknown(child);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function findFirstObject(value: unknown, predicate: (obj: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (predicate(obj)) return obj;
    for (const child of Object.values(obj)) {
      const found = findFirstObject(child, predicate);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFirstObject(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
let rateLimitedUntilMs = 0;

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

function assertSafeArg(value: string, flag: string): void {
  if (value.startsWith('--')) {
    throw new Error(`Refusing ${flag} value that starts with "--" (would be parsed as a gh flag): ${value.slice(0, 40)}`);
  }
}

async function runGhProject(args: string[]): Promise<unknown> {
  if (Date.now() < rateLimitedUntilMs) {
    throw new RateLimitError('GitHub board sync skipped: rate-limit cooldown active');
  }
  const result = await exec('gh', args, { timeout: 30000 });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || 'gh project command failed';
    if (/rate limit|secondary rate|abuse detection|HTTP 403/i.test(message)) {
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new RateLimitError(message);
    }
    throw new Error(message);
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : {};
}

async function lookupProject(owner: string, title: string): Promise<{ id: string; number: string } | null> {
  const payload = await runGhProject(['project', 'list', '--owner', owner, '--limit', '100', '--format', 'json']);
  const projects = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  const match = projects.find((project) => String(project.title ?? '') === title);
  if (!match) return null;
  return {
    id: String(match.id ?? ''),
    number: String(match.number ?? ''),
  };
}

async function createProject(owner: string, title: string): Promise<{ id: string; number: string }> {
  const payload = await runGhProject(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
  const project = findFirstObject(payload, (obj) => typeof obj.id === 'string' && obj.number != null);
  if (!project) throw new Error('Failed to parse gh project create response');
  return {
    id: String(project.id),
    number: String(project.number),
  };
}

async function lookupStatusField(owner: string, projectNumber: string): Promise<{
  fieldId: string;
  optionIds: Record<BoardStatus, string>;
} | null> {
  const payload = await runGhProject(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']);
  const fields = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  const field = fields.find((entry) => String(entry.name ?? '') === BOARD_FIELD_NAME);
  if (!field) return null;
  const options = Array.isArray(field.options) ? field.options : [];
  const optionIds = Object.fromEntries(
    BOARD_STATUSES.map((status) => {
      const match = options.find((option) => option && typeof option === 'object' && String((option as Record<string, unknown>).name ?? '') === status) as Record<string, unknown> | undefined;
      return [status, String(match?.id ?? '')];
    })
  ) as Record<BoardStatus, string>;
  if (BOARD_STATUSES.some((status) => !optionIds[status])) {
    throw new Error(`Existing ${BOARD_FIELD_NAME} field is missing one or more required options`);
  }
  return {
    fieldId: String(field.id ?? ''),
    optionIds,
  };
}

async function createStatusField(owner: string, projectNumber: string): Promise<{
  fieldId: string;
  optionIds: Record<BoardStatus, string>;
}> {
  const payload = await runGhProject([
    'project', 'field-create', projectNumber,
    '--owner', owner,
    '--name', BOARD_FIELD_NAME,
    '--data-type', 'SINGLE_SELECT',
    '--single-select-options', BOARD_STATUSES.join(','),
    '--format', 'json',
  ]);
  const field = findFirstObject(payload, (obj) => String(obj.name ?? '') === BOARD_FIELD_NAME || (typeof obj.id === 'string' && Array.isArray(obj.options)));
  if (!field) throw new Error('Failed to parse gh project field-create response');
  const options = Array.isArray(field.options) ? field.options : [];
  const optionIds = Object.fromEntries(
    BOARD_STATUSES.map((status) => {
      const match = options.find((option) => option && typeof option === 'object' && String((option as Record<string, unknown>).name ?? '') === status) as Record<string, unknown> | undefined;
      return [status, String(match?.id ?? '')];
    })
  ) as Record<BoardStatus, string>;
  if (BOARD_STATUSES.some((status) => !optionIds[status])) {
    throw new Error('Failed to resolve project field option IDs');
  }
  return {
    fieldId: String(field.id ?? ''),
    optionIds,
  };
}

export async function ensureProjectBoard(overrides?: Partial<BoardSettingsSnapshot>): Promise<EnsureBoardResult> {
  const settings = boardSettingsSnapshot(overrides);
  if (!settings.owner) {
    throw new Error('GitHub board sync requires a GitHub owner');
  }
  let project = await lookupProject(settings.owner, settings.title);
  if (!project) {
    project = await createProject(settings.owner, settings.title);
  }
  const field = await lookupStatusField(settings.owner, project.number) ?? await createStatusField(settings.owner, project.number);
  return {
    owner: settings.owner,
    title: settings.title,
    projectNumber: project.number,
    projectId: project.id,
    statusFieldId: field.fieldId,
    optionIds: field.optionIds,
  };
}

function isPipelineChild(job: JobData): boolean {
  return ['test', 'review', 'fix', 'commit', 'push', 'fix-push', 'mark-dod', 'pr-wait'].includes(job.kind);
}

function resolveRootJob(job: JobData): JobData | null {
  if (job.kind === 'release') return job;
  if (job.releaseId) return getJob(job.releaseId);
  if (job.parentJobId) {
    const parent = getJob(job.parentJobId);
    if (parent) return resolveRootJob(parent) ?? parent;
  }
  return job.parentJobId || isPipelineChild(job) ? null : job;
}

function jobUrl(job: JobData): string {
  const baseUrl = process.env.TAMTAM_BASE_URL || 'http://localhost:1337';
  if (job.kind === 'release') {
    return `${baseUrl}/project/${encodeURIComponent(job.project)}/release/${encodeURIComponent(job.id)}`;
  }
  return `${baseUrl}/project/${encodeURIComponent(job.project)}/terminal?job=${encodeURIComponent(job.id)}`;
}

async function resolveBranch(job: JobData): Promise<string> {
  const projPath = resolveProjectPath(job.project);
  if (!projPath) return '';
  const result = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

function buildIssueContext(job: JobData): string {
  if (job.ghIssueNumber && job.ghIssueRepo) {
    return `${job.ghIssueRepo}#${job.ghIssueNumber}${job.ghIssueTitle ? ` — ${job.ghIssueTitle}` : ''}`;
  }
  const parent = job.parentJobId ? getJob(job.parentJobId) : null;
  if (parent?.ghIssueNumber && parent.ghIssueRepo) {
    return `${parent.ghIssueRepo}#${parent.ghIssueNumber}${parent.ghIssueTitle ? ` — ${parent.ghIssueTitle}` : ''}`;
  }
  return '';
}

function rootPrompt(job: JobData): string {
  if (job.userPrompt) return job.userPrompt;
  if (job.prompt) return job.prompt;
  const parent = job.parentJobId ? getJob(job.parentJobId) : null;
  if (parent?.userPrompt) return parent.userPrompt;
  if (parent?.prompt) return parent.prompt;
  return job.kind === 'release' ? 'Release pipeline triggered.' : '';
}

function buildRootTitle(job: JobData, branch: string): string {
  const label = job.kind.startsWith('agent:') ? 'agent run' : job.kind;
  return `[${job.project}] ${label}${branch ? ` · ${branch}` : ''} · ${job.id}`;
}

function buildBody(job: JobData, boardMeta: StoredBoardMeta): string {
  const branch = boardMeta.branch || '';
  const activities = boardMeta.activities ?? [];
  const issueContext = buildIssueContext(job);
  const prompt = rootPrompt(job).trim();
  return [
    `TamTam Job ID: ${job.id}`,
    `Project: ${job.project}`,
    `Run kind: ${job.kind}`,
    `Branch: ${branch || '(unknown)'}`,
    `Run URL: ${jobUrl(job)}`,
    issueContext ? `Issue/PR context: ${issueContext}` : '',
    '',
    'Task',
    prompt || '(no prompt recorded)',
    '',
    'Activity',
    ...(activities.length > 0 ? activities.map((entry) => `- ${entry.line}`) : ['- created']),
  ].filter(Boolean).join('\n');
}

function buildActivityLine(job: JobData, phase: BoardSyncPhase): { key: string; line: string } | null {
  if (phase === 'manual') return null;
  const transition = deriveBoardTransition(job, phase);
  const detail = job.kind === 'review' && job.verdict ? ` · verdict ${job.verdict}` : '';
  return {
    key: `${phase}:${job.id}:${job.exitCode ?? 'running'}:${job.verdict ?? ''}:${job.abortedAt ?? ''}`,
    line: `${transition.summary}${detail} — ${jobUrl(job)}`,
  };
}

async function findItemByMarker(owner: string, projectNumber: string, jobId: string): Promise<string | null> {
  const payload = await runGhProject(['project', 'item-list', projectNumber, '--owner', owner, '--limit', '1000', '--format', 'json']);
  const items = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  const item = items.find((entry) => JSON.stringify(entry).includes(`TamTam Job ID: ${jobId}`) || JSON.stringify(entry).includes(jobId));
  return item ? String(item.id ?? '') || null : null;
}

async function ensureItem(rootJob: JobData, settings: EnsureBoardResult, boardMeta: StoredBoardMeta, body: string): Promise<string> {
  if (boardMeta.itemId) return boardMeta.itemId;
  const existing = await findItemByMarker(settings.owner, settings.projectNumber, rootJob.id);
  if (existing) return existing;
  const title = boardMeta.title || buildRootTitle(rootJob, boardMeta.branch || '');
  assertSafeArg(title, '--title');
  assertSafeArg(body, '--body');
  const payload = await runGhProject([
    'project', 'item-create', settings.projectNumber,
    '--owner', settings.owner,
    '--title', title,
    '--body', body,
    '--format', 'json',
  ]);
  const item = findFirstObject(payload, (obj) => typeof obj.id === 'string');
  if (!item?.id) throw new Error('Failed to parse gh project item-create response');
  return String(item.id);
}

async function updateItemBody(itemId: string, title: string, body: string): Promise<void> {
  assertSafeArg(title, '--title');
  assertSafeArg(body, '--body');
  await runGhProject(['project', 'item-edit', '--id', itemId, '--title', title, '--body', body, '--format', 'json']);
}

async function updateItemStatus(itemId: string, settings: EnsureBoardResult, status: BoardStatus): Promise<void> {
  await runGhProject([
    'project', 'item-edit',
    '--id', itemId,
    '--project-id', settings.projectId,
    '--field-id', settings.statusFieldId,
    '--single-select-option-id', settings.optionIds[status],
    '--format', 'json',
  ]);
}

const jobSyncQueues = new Map<string, Promise<void>>();

export async function syncJobToProjectBoard(
  job: JobData,
  phase: BoardSyncPhase,
  options: SyncJobToProjectBoardOptions = {},
): Promise<void> {
  const settings = boardSettingsSnapshot();
  if (!hasBoardSyncConfigured(settings)) {
    if (options.requireConfigured) {
      throw new Error(boardSettingsError(settings) ?? 'GitHub board sync is not fully configured.');
    }
    return;
  }

  const initialRoot = resolveRootJob(job);
  if (!initialRoot) return;

  const ensureSettings: EnsureBoardResult = {
    owner: settings.owner,
    title: settings.title,
    projectNumber: settings.projectNumber,
    projectId: settings.projectId,
    statusFieldId: settings.statusFieldId,
    optionIds: settings.optionIds as Record<BoardStatus, string>,
  };
  const transition = deriveBoardTransition(job, phase);

  const previous = jobSyncQueues.get(initialRoot.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const rootJob = getJob(initialRoot.id) ?? initialRoot;
      const boardMeta = getBoardMeta(rootJob);
      if (!boardMeta.branch) boardMeta.branch = await resolveBranch(rootJob);
      if (!boardMeta.title) boardMeta.title = buildRootTitle(rootJob, boardMeta.branch || '');
      if (!boardMeta.activities) boardMeta.activities = [];

      const activity = buildActivityLine(job, phase);
      if (activity && !boardMeta.activities.some((entry) => entry.key === activity.key)) {
        boardMeta.activities.push(activity);
        boardMeta.activities = boardMeta.activities.slice(-100);
      }

      const body = buildBody(rootJob, boardMeta);
      const itemId = await ensureItem(rootJob, ensureSettings, boardMeta, body);
      boardMeta.itemId = itemId;
      setBoardMeta(rootJob, boardMeta);
      await updateItemBody(itemId, boardMeta.title, body);
      await updateItemStatus(itemId, ensureSettings, transition.status);
    });
  jobSyncQueues.set(initialRoot.id, next);
  try {
    await next;
  } finally {
    if (jobSyncQueues.get(initialRoot.id) === next) {
      jobSyncQueues.delete(initialRoot.id);
    }
  }
}

export async function queueJobBoardSync(job: JobData, phase: BoardSyncPhase): Promise<void> {
  try {
    await syncJobToProjectBoard(job, phase);
  } catch (error) {
    console.error(`[github-board] sync failed for ${job.id} (${phase})`, error);
  }
}
