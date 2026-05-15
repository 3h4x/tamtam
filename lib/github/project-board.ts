import { db, schema } from '@/lib/db';
import { getJob, listJobs, updateJob } from '@/lib/jobs/storage';
import type { JobData } from '@/lib/jobs/types';
import { getSettings, reloadConfig } from '@/lib/shared/config';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';
import { costUsd, totalTokens } from '@/lib/shared/usage-pricing';
import { getJobKind, isAgentJobKind } from '@/lib/jobs/kinds';
import { BOARD_STATUSES, deriveBoardTransition, type BoardStatus, type BoardSyncPhase } from './project-board-status';

const BOARD_FIELD_NAME = 'Status';
const BOARD_META_KEY = 'githubBoard';

const STATUS_OPTION_COLORS: Record<BoardStatus, string> = {
  'Todo': 'GRAY',
  'In Progress': 'YELLOW',
  'Review': 'BLUE',
  'Fixing': 'ORANGE',
  'Blocked': 'RED',
  'Done': 'GREEN',
};

const STATUS_OPTION_DESCRIPTIONS: Record<BoardStatus, string> = {
  'Todo': 'Queued and not yet started',
  'In Progress': 'Actively running',
  'Review': 'Awaiting code review',
  'Fixing': 'Applying fixes after review',
  'Blocked': 'Blocked by a failure or attention required',
  'Done': 'Finished successfully',
};

const BOARD_CUSTOM_FIELDS = [
  { key: 'project', name: 'Project', dataType: 'TEXT' },
  { key: 'agent', name: 'Agent', dataType: 'TEXT' },
  { key: 'kind', name: 'Run kind', dataType: 'TEXT' },
  { key: 'branch', name: 'Branch', dataType: 'TEXT' },
] as const;

type BoardCustomFieldKey = (typeof BOARD_CUSTOM_FIELDS)[number]['key'];
type BoardCustomFieldIds = Partial<Record<BoardCustomFieldKey, string>>;
type BoardCustomFieldValues = Partial<Record<BoardCustomFieldKey, string>>;

type BoardOptionIds = Partial<Record<BoardStatus, string>>;

interface StoredBoardMeta {
  itemId?: string;
  title?: string;
  branch?: string;
  activities?: Array<{ key: string; line: string }>;
  customFields?: BoardCustomFieldValues;
}

interface BoardSettingsSnapshot {
  enabled: boolean;
  owner: string;
  title: string;
  projectNumber: string;
  projectUrl: string;
  projectId: string;
  statusFieldId: string;
  optionIds: BoardOptionIds;
  customFieldIds: BoardCustomFieldIds;
}

export interface EnsureBoardResult {
  owner: string;
  title: string;
  projectNumber: string;
  projectUrl: string;
  projectId: string;
  statusFieldId: string;
  optionIds: Record<BoardStatus, string>;
  customFieldIds: BoardCustomFieldIds;
}

function buildProjectUrl(owner: string, projectNumber: string, ownerType: string): string {
  if (!owner || !projectNumber) return '';
  const segment = ownerType === 'Organization' ? 'orgs' : 'users';
  return `https://github.com/${segment}/${owner}/projects/${projectNumber}`;
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
    projectUrl: overrides?.projectUrl ?? settings.github_board_project_url,
    projectId: overrides?.projectId ?? settings.github_board_project_id,
    statusFieldId: overrides?.statusFieldId ?? settings.github_board_status_field_id,
    optionIds: overrides?.optionIds ?? settings.github_board_status_option_ids,
    customFieldIds: overrides?.customFieldIds ?? settings.github_board_custom_field_ids ?? {},
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

function settingsToEnsureResult(
  settings: BoardSettingsSnapshot & {
    owner: string;
    projectNumber: string;
    projectId: string;
    statusFieldId: string;
  },
): EnsureBoardResult {
  return {
    owner: settings.owner,
    title: settings.title,
    projectNumber: settings.projectNumber,
    projectUrl: settings.projectUrl,
    projectId: settings.projectId,
    statusFieldId: settings.statusFieldId,
    optionIds: settings.optionIds as Record<BoardStatus, string>,
    customFieldIds: settings.customFieldIds,
  };
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

function isBoardSettingsUpgradeNeeded(settings: BoardSettingsSnapshot): boolean {
  if (!settings.enabled || !settings.owner) return false;
  if (!settings.projectNumber || !settings.projectId || !settings.statusFieldId) return true;
  if (BOARD_STATUSES.some((status) => !settings.optionIds[status])) return true;
  if (!settings.projectUrl) return true;
  return BOARD_CUSTOM_FIELDS.some((field) => !settings.customFieldIds[field.key]);
}

function persistBoardProvisioning(result: EnsureBoardResult): void {
  const entries = [
    { key: 'github_board_project_owner', value: result.owner },
    { key: 'github_board_project_title', value: result.title },
    { key: 'github_board_project_number', value: result.projectNumber },
    { key: 'github_board_project_url', value: result.projectUrl },
    { key: 'github_board_project_id', value: result.projectId },
    { key: 'github_board_status_field_id', value: result.statusFieldId },
    { key: 'github_board_status_option_ids', value: JSON.stringify(result.optionIds) },
    { key: 'github_board_custom_field_ids', value: JSON.stringify(result.customFieldIds) },
  ] as const;

  for (const entry of entries) {
    db.insert(schema.settings)
      .values({ key: entry.key, value: entry.value })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: entry.value },
      })
      .execute()
      .catch((e) => console.error('[project-board] failed to persist board settings:', e));
  }
  reloadConfig();
}

async function ensureConfiguredBoardSettings(
  settings: BoardSettingsSnapshot,
): Promise<EnsureBoardResult | null> {
  if (!settings.enabled || !settings.owner) return null;
  if (hasBoardSyncConfigured(settings) && !isBoardSettingsUpgradeNeeded(settings)) {
    return settingsToEnsureResult(settings);
  }

  const ensured = await ensureProjectBoard({
    enabled: true,
    owner: settings.owner,
    title: settings.title,
  });
  persistBoardProvisioning(ensured);
  return ensured;
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

function isExplicitRateLimitMessage(message: string): boolean {
  return /rate-limit cooldown active|rate limit exceeded|secondary rate limit|abuse detection/i.test(message);
}

export function isBoardSyncRateLimitError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'RateLimitError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return isExplicitRateLimitMessage(message);
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
    if (isExplicitRateLimitMessage(message)) {
      rateLimitedUntilMs = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new RateLimitError(message);
    }
    throw new Error(message);
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : {};
}

async function lookupProject(owner: string, title: string): Promise<{ id: string; number: string; url: string } | null> {
  const payload = await runGhProject(['project', 'list', '--owner', owner, '--limit', '100', '--format', 'json']);
  const projects = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  const match = projects.find((project) => String(project.title ?? '') === title);
  if (!match) return null;
  const number = String(match.number ?? '');
  const ownerObj = match.owner && typeof match.owner === 'object' ? match.owner as Record<string, unknown> : {};
  const url = String(match.url ?? '') || buildProjectUrl(owner, number, String(ownerObj.type ?? ''));
  return {
    id: String(match.id ?? ''),
    number,
    url,
  };
}

async function createProject(owner: string, title: string): Promise<{ id: string; number: string; url: string }> {
  const payload = await runGhProject(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
  const project = findFirstObject(payload, (obj) => typeof obj.id === 'string' && obj.number != null);
  if (!project) throw new Error('Failed to parse gh project create response');
  const number = String(project.number);
  const ownerObj = project.owner && typeof project.owner === 'object' ? project.owner as Record<string, unknown> : {};
  const url = String(project.url ?? '') || buildProjectUrl(owner, number, String(ownerObj.type ?? ''));
  return {
    id: String(project.id),
    number,
    url,
  };
}

function readFieldOptions(field: Record<string, unknown>): Array<{ id: string; name: string }> {
  const options = Array.isArray(field.options) ? field.options : [];
  return options
    .filter((option): option is Record<string, unknown> => !!option && typeof option === 'object' && !Array.isArray(option))
    .map((option) => ({ id: String(option.id ?? ''), name: String(option.name ?? '') }));
}

function lookupStatusFieldFromPayload(payload: unknown): Record<string, unknown> | null {
  const fields = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  return fields.find((entry) => String(entry.name ?? '') === BOARD_FIELD_NAME) ?? null;
}

async function fetchAllFields(owner: string, projectNumber: string): Promise<Array<Record<string, unknown>>> {
  const payload = await runGhProject(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']);
  return maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
}

async function fetchStatusField(owner: string, projectNumber: string): Promise<Record<string, unknown> | null> {
  const payload = await runGhProject(['project', 'field-list', projectNumber, '--owner', owner, '--format', 'json']);
  return lookupStatusFieldFromPayload(payload);
}

function buildOptionIds(field: Record<string, unknown>): Record<BoardStatus, string> {
  const options = readFieldOptions(field);
  const optionIds = Object.fromEntries(
    BOARD_STATUSES.map((status) => {
      const match = options.find((option) => option.name === status);
      return [status, match?.id ?? ''];
    })
  ) as Record<BoardStatus, string>;
  return optionIds;
}

async function ensureStatusOptions(
  owner: string,
  projectNumber: string,
  field: Record<string, unknown>,
): Promise<Record<BoardStatus, string>> {
  let optionIds = buildOptionIds(field);
  const missing = BOARD_STATUSES.filter((status) => !optionIds[status]);
  if (missing.length === 0) return optionIds;

  const fieldId = String(field.id ?? '');
  if (!fieldId) throw new Error(`Built-in ${BOARD_FIELD_NAME} field has no ID`);

  // updateProjectV2Field replaces the full option list. Send every existing
  // option (so its ID is preserved by name match) plus the missing TamTam
  // statuses with our chosen colors.
  const existing = readFieldOptions(field);
  const merged: Array<{ name: string; color: string; description: string }> = [];
  const seen = new Set<string>();
  for (const opt of existing) {
    if (!opt.name || seen.has(opt.name)) continue;
    seen.add(opt.name);
    const status = opt.name as BoardStatus;
    const color = STATUS_OPTION_COLORS[status] ?? 'GRAY';
    const description = STATUS_OPTION_DESCRIPTIONS[status] ?? '';
    merged.push({ name: opt.name, color, description });
  }
  for (const status of missing) {
    if (seen.has(status)) continue;
    seen.add(status);
    merged.push({
      name: status,
      color: STATUS_OPTION_COLORS[status],
      description: STATUS_OPTION_DESCRIPTIONS[status],
    });
  }

  const optionsLiteral = merged
    .map((opt) => `{name: ${JSON.stringify(opt.name)}, color: ${opt.color}, description: ${JSON.stringify(opt.description)}}`)
    .join(', ');
  const query = `mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, singleSelectOptions: [${optionsLiteral}] }) { projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`;
  await runGhProject(['api', 'graphql', '-f', `query=${query}`]);

  const refreshed = await fetchStatusField(owner, projectNumber);
  if (!refreshed) throw new Error(`Failed to re-read ${BOARD_FIELD_NAME} field after adding options`);
  optionIds = buildOptionIds(refreshed);
  if (BOARD_STATUSES.some((status) => !optionIds[status])) {
    throw new Error(`Failed to add required options to the built-in ${BOARD_FIELD_NAME} field`);
  }
  return optionIds;
}

async function ensureCustomFields(
  owner: string,
  projectNumber: string,
  existingFields: Array<Record<string, unknown>>,
): Promise<BoardCustomFieldIds> {
  const ids: BoardCustomFieldIds = {};
  for (const def of BOARD_CUSTOM_FIELDS) {
    const found = existingFields.find((entry) => String(entry.name ?? '') === def.name);
    if (found) {
      ids[def.key] = String(found.id ?? '');
      continue;
    }
    const payload = await runGhProject([
      'project', 'field-create', projectNumber,
      '--owner', owner,
      '--name', def.name,
      '--data-type', def.dataType,
      '--format', 'json',
    ]);
    const created = findFirstObject(payload, (obj) => typeof obj.id === 'string' && String(obj.name ?? '') === def.name)
      ?? findFirstObject(payload, (obj) => typeof obj.id === 'string');
    if (created?.id) ids[def.key] = String(created.id);
  }
  return ids;
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
  const fields = await fetchAllFields(settings.owner, project.number);
  const statusField = fields.find((entry) => String(entry.name ?? '') === BOARD_FIELD_NAME);
  if (!statusField) {
    throw new Error(`Built-in ${BOARD_FIELD_NAME} field not found on project — GitHub provisions one by default; the project may be misconfigured.`);
  }
  const optionIds = await ensureStatusOptions(settings.owner, project.number, statusField);
  const customFieldIds = await ensureCustomFields(settings.owner, project.number, fields);
  return {
    owner: settings.owner,
    title: settings.title,
    projectNumber: project.number,
    projectUrl: project.url,
    projectId: project.id,
    statusFieldId: String(statusField.id ?? ''),
    optionIds,
    customFieldIds,
  };
}

function isPipelineChild(job: JobData): boolean {
  return ['test', 'review', 'fix', 'commit', 'push', 'mark-dod', 'pr-wait'].includes(job.kind);
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

function extractAgentName(job: JobData): string {
  const kind = getJobKind(job.kind);
  return isAgentJobKind(kind) ? kind.slice('agent:'.length) : '';
}

function buildRootTitle(job: JobData, branch: string): string {
  if (job.ghIssueTitle) {
    return job.ghIssueNumber ? `${job.ghIssueTitle} (#${job.ghIssueNumber})` : job.ghIssueTitle;
  }
  const agent = extractAgentName(job);
  if (agent) return `${agent} agent · ${job.project}`;
  if (job.kind === 'release') return `release · ${job.project}${branch ? ` · ${branch}` : ''}`;
  if (job.kind === 'run') {
    const prompt = (job.userPrompt || job.prompt || '').trim().split('\n')[0] || 'run';
    const truncated = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
    return `${truncated} · ${job.project}`;
  }
  return `${job.kind} · ${job.project}${branch ? ` · ${branch}` : ''}`;
}

function buildCustomFieldValues(job: JobData, branch: string): BoardCustomFieldValues {
  return {
    project: job.project,
    agent: extractAgentName(job),
    kind: job.kind,
    branch: branch || '',
  };
}

async function updateItemCustomFields(
  itemId: string,
  settings: EnsureBoardResult,
  desired: BoardCustomFieldValues,
  written: BoardCustomFieldValues,
): Promise<BoardCustomFieldValues> {
  const merged: BoardCustomFieldValues = { ...written };
  for (const def of BOARD_CUSTOM_FIELDS) {
    const fieldId = settings.customFieldIds[def.key];
    if (!fieldId) continue;
    const value = desired[def.key] ?? '';
    if (written[def.key] === value) continue;
    if (value === '') {
      // Clear the field if the value is now empty (e.g. agent name on a non-agent run).
      await runGhProject([
        'project', 'item-edit',
        '--id', itemId,
        '--project-id', settings.projectId,
        '--field-id', fieldId,
        '--clear',
        '--format', 'json',
      ]);
    } else {
      assertSafeArg(value, '--text');
      await runGhProject([
        'project', 'item-edit',
        '--id', itemId,
        '--project-id', settings.projectId,
        '--field-id', fieldId,
        '--text', value,
        '--format', 'json',
      ]);
    }
    merged[def.key] = value;
  }
  return merged;
}

function descendantJobs(rootJob: JobData): JobData[] {
  const all = listJobs();
  const out: JobData[] = [];
  for (const j of all) {
    if (j.id === rootJob.id) continue;
    if (j.releaseId && j.releaseId === rootJob.id) {
      out.push(j);
      continue;
    }
    let cursor: JobData | null = j;
    let depth = 0;
    while (cursor && depth < 10) {
      if (cursor.parentJobId === rootJob.id) {
        out.push(j);
        break;
      }
      cursor = cursor.parentJobId ? getJob(cursor.parentJobId) : null;
      depth++;
    }
  }
  return out;
}

function formatHumanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function durationLine(rootJob: JobData): string {
  const start = rootJob.startedAt ?? null;
  if (!start) return '';
  const end = rootJob.finishedAt ?? Math.floor(Date.now() / 1000);
  const ms = (end - start) * 1000;
  const human = formatHumanDuration(ms);
  return rootJob.finishedAt ? `Duration: ${human}` : `Duration: running for ${human}`;
}

function aggregateTokens(rootJob: JobData): { input: number; output: number; cacheRead: number; cacheCreate: number } {
  const jobs = [rootJob, ...descendantJobs(rootJob)];
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  for (const j of jobs) {
    input += j.inputTokens ?? 0;
    output += j.outputTokens ?? 0;
    cacheRead += j.cacheReadTokens ?? 0;
    cacheCreate += j.cacheCreateTokens ?? 0;
  }
  return { input, output, cacheRead, cacheCreate };
}

function costLine(rootJob: JobData): string {
  const tokens = aggregateTokens(rootJob);
  const total = totalTokens({
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreateTokens: tokens.cacheCreate,
  });
  if (total === 0) return '';
  const cost = costUsd({
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreateTokens: tokens.cacheCreate,
  });
  const costStr = cost < 0.0001 ? '<$0.0001' : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  const totalStr = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
  return `Cost: ${costStr} · ${totalStr} tokens (in ${tokens.input} / out ${tokens.output} / cache-read ${tokens.cacheRead})`;
}

function verdictLine(rootJob: JobData): string {
  if (rootJob.verdict) return `Verdict: ${rootJob.verdict}`;
  const descendants = descendantJobs(rootJob).filter((j) => j.kind === 'review' && j.verdict);
  descendants.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const latest = descendants[0];
  return latest?.verdict ? `Verdict: ${latest.verdict} (review ${latest.id.slice(0, 7)})` : '';
}

function statusDetailLine(boardMeta: StoredBoardMeta): string {
  const last = boardMeta.activities?.[boardMeta.activities.length - 1];
  return last ? `Status detail: ${last.line}` : '';
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
    verdictLine(job),
    durationLine(job),
    costLine(job),
    statusDetailLine(boardMeta),
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

function resolveIssueRef(job: JobData): { repo: string; number: number } | null {
  if (job.ghIssueNumber && job.ghIssueRepo) {
    return { repo: job.ghIssueRepo, number: job.ghIssueNumber };
  }
  const parent = job.parentJobId ? getJob(job.parentJobId) : null;
  if (parent?.ghIssueNumber && parent.ghIssueRepo) {
    return { repo: parent.ghIssueRepo, number: parent.ghIssueNumber };
  }
  return null;
}

function issueRefUrls(issueRef: { repo: string; number: number }): string[] {
  return [
    `https://github.com/${issueRef.repo}/issues/${issueRef.number}`,
    `https://github.com/${issueRef.repo}/pull/${issueRef.number}`,
  ];
}

function linkedContentUrl(entry: Record<string, unknown>): string {
  const content = entry.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const url = (content as Record<string, unknown>).url;
  return typeof url === 'string' ? url : '';
}

async function findItem(
  owner: string,
  projectNumber: string,
  jobId: string,
  issueRef: { repo: string; number: number } | null,
): Promise<string | null> {
  const payload = await runGhProject(['project', 'item-list', projectNumber, '--owner', owner, '--limit', '1000', '--format', 'json']);
  const items = maybeArrayFromUnknown(payload).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));

  if (issueRef) {
    const validUrls = new Set(issueRefUrls(issueRef));
    const matched = items.find((entry) => validUrls.has(linkedContentUrl(entry)));
    if (matched) return String(matched.id ?? '') || null;
  }

  const item = items.find((entry) => JSON.stringify(entry).includes(`TamTam Job ID: ${jobId}`));
  return item ? String(item.id ?? '') || null : null;
}

async function ensureItem(rootJob: JobData, settings: EnsureBoardResult, boardMeta: StoredBoardMeta, body: string): Promise<string> {
  // Trust any stored item ID with a real GitHub prefix:
  //   PVTI_ — project v2 item (the canonical id)
  //   DI_   — DraftIssue content node (older runs persisted the inner id)
  // Skipping rediscovery here is the dominant cost saving on bulk resyncs:
  // findItem issues a full project item-list call which is the biggest
  // contributor to GitHub secondary rate-limit trips.
  if (boardMeta.itemId && (boardMeta.itemId.startsWith('PVTI_') || boardMeta.itemId.startsWith('DI_'))) {
    return boardMeta.itemId;
  }

  const issueRef = resolveIssueRef(rootJob);
  const existing = await findItem(settings.owner, settings.projectNumber, rootJob.id, issueRef);
  if (existing) return existing;

  if (issueRef) {
    // Add the issue/PR itself to the board so the card is content-linked,
    // not a draft. We try /issues first; if the resource is a PR, gh will
    // accept the /pull URL.
    const issueUrl = `https://github.com/${issueRef.repo}/issues/${issueRef.number}`;
    const prUrl = `https://github.com/${issueRef.repo}/pull/${issueRef.number}`;
    let payload: unknown;
    try {
      payload = await runGhProject([
        'project', 'item-add', settings.projectNumber,
        '--owner', settings.owner,
        '--url', issueUrl,
        '--format', 'json',
      ]);
    } catch {
      payload = await runGhProject([
        'project', 'item-add', settings.projectNumber,
        '--owner', settings.owner,
        '--url', prUrl,
        '--format', 'json',
      ]);
    }
    const added = findFirstObject(payload, (obj) => typeof obj.id === 'string');
    if (added?.id) return String(added.id);
    // fall through to draft creation if we can't parse the response
  }

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
  const draftItem = findFirstObject(payload, (obj) => typeof obj.id === 'string' && String(obj.id).startsWith('DI_'));
  if (draftItem?.id) return String(draftItem.id);
  const item = findFirstObject(payload, (obj) => typeof obj.id === 'string');
  if (!item?.id) throw new Error('Failed to parse gh project item-create response');
  return String(item.id);
}

async function updateItemBody(itemId: string, title: string, body: string): Promise<void> {
  // gh project item-edit --title/--body only works on draft items. For
  // content-linked items (real issues/PRs), skip the body update — the card
  // still gets its Status field updated via updateItemStatus below.
  if (!itemId.startsWith('DI_')) return;
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

export function logBoardSyncError(jobId: string, phase: BoardSyncPhase, error: unknown): void {
  if (isBoardSyncRateLimitError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[github-board] sync skipped for ${jobId} (${phase}): ${message}`);
    return;
  }
  console.error(`[github-board] sync failed for ${jobId} (${phase})`, error);
}

export async function syncJobToProjectBoard(
  job: JobData,
  phase: BoardSyncPhase,
  options: SyncJobToProjectBoardOptions = {},
): Promise<void> {
  const settings = boardSettingsSnapshot();
  const ensureSettings = await ensureConfiguredBoardSettings(settings);
  if (!ensureSettings) {
    if (options.requireConfigured) {
      throw new Error(boardSettingsError(settings) ?? 'GitHub board sync is not fully configured.');
    }
    return;
  }

  const initialRoot = resolveRootJob(job);
  if (!initialRoot) return;
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
      const desiredCustomFields = buildCustomFieldValues(rootJob, boardMeta.branch || '');
      let itemId = await ensureItem(rootJob, ensureSettings, boardMeta, body);
      boardMeta.itemId = itemId;
      setBoardMeta(rootJob, boardMeta);
      const writeFields = async (id: string) => {
        await updateItemBody(id, boardMeta.title!, body);
        await updateItemStatus(id, ensureSettings, transition.status);
        const merged = await updateItemCustomFields(id, ensureSettings, desiredCustomFields, boardMeta.customFields ?? {});
        boardMeta.customFields = merged;
        setBoardMeta(rootJob, boardMeta);
      };
      try {
        await writeFields(itemId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Stored itemId points at a card the user (or GitHub) deleted. Drop
        // it so the next attempt rediscovers / recreates, then retry once
        // within this same sync.
        if (/resource not found|could not resolve to a node|item not found/i.test(message)) {
          delete boardMeta.itemId;
          delete boardMeta.customFields;
          setBoardMeta(rootJob, boardMeta);
          itemId = await ensureItem(rootJob, ensureSettings, boardMeta, body);
          boardMeta.itemId = itemId;
          setBoardMeta(rootJob, boardMeta);
          await writeFields(itemId);
        } else {
          throw error;
        }
      }
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
    logBoardSyncError(job.id, phase, error);
  }
}
