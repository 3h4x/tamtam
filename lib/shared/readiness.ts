import { accessSync, constants, existsSync } from 'fs';
import { sql } from 'drizzle-orm';
import { homedir } from 'os';
import { join } from 'path';
import { db, schema } from '@/lib/db';
import { getSettings, type TamTamConfig } from '@/lib/shared/config';
import { exec } from '@/lib/shared/shell';
import { resolveCliBin, resolveCliEnv } from '@/lib/shared/cli-bin';
import { listEnabledProjects } from '@/lib/shared/enabled-projects';
import { CLI_PROVIDERS_WITH_QUOTA, type CliProvider } from '@/lib/usage/cli-providers';
import { getQuotaForProvider } from '@/lib/usage/quota';
import { ProviderNotConfiguredError } from '@/lib/usage/quota-types';

export type ReadinessSeverity = 'info' | 'warn' | 'error';

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  severity: ReadinessSeverity;
  message: string;
}

export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessOptions {
  projectName?: string;
  provider?: CliProvider;
  includeQuota?: boolean;
}

function check(name: string, ok: boolean, severity: ReadinessSeverity, message: string): ReadinessCheck {
  return { name, ok, severity, message };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function canExecutePath(path: string): boolean {
  try {
    accessSync(/*turbopackIgnore: true*/ path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(command: string): Promise<boolean> {
  const result = await exec('bash', ['-lc', `command -v "$1" >/dev/null 2>&1`, '_', command], { timeout: 3000 });
  return result.exitCode === 0;
}

async function executableExists(value: string): Promise<boolean> {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  const expanded = expandHome(trimmed);
  if (expanded.includes('/')) return canExecutePath(expanded);
  return commandExists(expanded);
}

async function providerBinaryCheck(provider: CliProvider, settings: TamTamConfig): Promise<ReadinessCheck> {
  const shim = resolveCliBin(provider, settings);
  if (!canExecutePath(shim) && !existsSync(/*turbopackIgnore: true*/ shim)) {
    return check(
      `provider:${provider}`,
      false,
      'error',
      `Configured ${provider} shim is missing: ${shim}`,
    );
  }

  const env = resolveCliEnv(provider, settings);
  const binEntries = Object.entries(env).filter(([key]) => key.endsWith('_BIN'));
  for (const [, value] of binEntries) {
    if (!(await executableExists(value))) {
      return check(
        `provider:${provider}`,
        false,
        'error',
        `Configured ${provider} binary is not executable: ${value}`,
      );
    }
  }

  return check(`provider:${provider}`, true, 'info', `${provider} launcher is available`);
}

async function dbCheck(): Promise<ReadinessCheck> {
  try {
    await db.execute(sql`select 1`);
    return check('db', true, 'info', 'Postgres query succeeded');
  } catch (err) {
    return check('db', false, 'error', `Postgres query failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pm2Check(): Promise<ReadinessCheck> {
  const result = await exec('pm2', ['--version'], { timeout: 5000 });
  if (result.exitCode === 0) return check('pm2', true, 'info', 'PM2 is available');
  return check('pm2', false, 'error', `PM2 unavailable: ${(result.stderr || result.stdout || 'command failed').trim()}`);
}

function workspaceCheck(settings: TamTamConfig): ReadinessCheck {
  const workspace = settings.workspace_path.trim();
  if (!workspace) return check('workspace', false, 'warn', 'Workspace path is not configured');
  const path = expandHome(workspace);
  if (!existsSync(/*turbopackIgnore: true*/ path)) {
    return check('workspace', false, 'error', `Workspace path does not exist: ${path}`);
  }
  return check('workspace', true, 'info', `Workspace path exists: ${path}`);
}

function projectPathCheck(projectName: string): ReadinessCheck {
  const project = listEnabledProjects({ includeArchived: true }).find((p) => p.name === projectName);
  if (!project) return check('project-path', false, 'error', `Project ${projectName} is not configured`);
  if (!existsSync(/*turbopackIgnore: true*/ project.path)) {
    return check('project-path', false, 'error', `Project path does not exist: ${project.path}`);
  }
  return check('project-path', true, 'info', `Project path exists: ${project.path}`);
}

async function schedulerCheck(): Promise<ReadinessCheck> {
  const connectionString = process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL ?? '';
  if (!connectionString) {
    return check('scheduler', false, 'warn', 'No Postgres URL configured for graphile-worker scheduler');
  }
  return check('scheduler', true, 'info', 'Graphile-worker scheduler has a Postgres connection string');
}

async function prWorkflowEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select({ autoPushEnabled: schema.projects.autoPushEnabled, archived: schema.projects.archived, enabled: schema.projects.enabled })
      .from(schema.projects);
    return rows.some((row) => row.enabled !== false && !row.archived && row.autoPushEnabled === true);
  } catch {
    return false;
  }
}

async function ghCheck(): Promise<ReadinessCheck | null> {
  if (!(await prWorkflowEnabled())) return null;
  const result = await exec('gh', ['auth', 'status'], { timeout: 8000 });
  if (result.exitCode === 0) return check('gh', true, 'info', 'GitHub CLI is authenticated');
  return check('gh', false, 'warn', `GitHub CLI auth unavailable: ${(result.stderr || result.stdout || 'gh auth status failed').trim()}`);
}

function quotaMessage(err: unknown): { severity: ReadinessSeverity; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof ProviderNotConfiguredError) {
    return { severity: 'warn', message: raw };
  }
  if (raw.includes('rate-limited') || raw.includes('backing off')) {
    return { severity: 'warn', message: 'Quota temporarily unavailable due to provider rate limiting or backoff' };
  }
  return { severity: 'warn', message: raw };
}

async function quotaChecks(settings: TamTamConfig): Promise<ReadinessCheck[]> {
  if (!settings.budget_block_runs_enabled) {
    return [check('quota', true, 'info', 'Budget gate disabled; quota fetch is not required')];
  }
  const providers = settings.cli_enabled_providers.filter((provider): provider is 'claude' | 'codex' =>
    CLI_PROVIDERS_WITH_QUOTA.includes(provider)
  );
  if (providers.length === 0) {
    return [check('quota', true, 'info', 'No enabled provider requires quota fetches')];
  }
  return Promise.all(providers.map(async (provider) => {
    try {
      const snapshot = await getQuotaForProvider(provider);
      return check(`quota:${provider}`, true, snapshot.stale ? 'warn' : 'info', snapshot.stale ? `${provider} quota using stale cached data` : `${provider} quota fetched`);
    } catch (err) {
      const msg = quotaMessage(err);
      return check(`quota:${provider}`, false, msg.severity, msg.message);
    }
  }));
}

export async function getReadinessReport(options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const settings = getSettings();
  const providers = options.provider ? [options.provider] : settings.cli_enabled_providers;
  // Fan out every independent check in parallel. The previous sequential
  // `await dbCheck(); await pm2Check(); ...` chain made every `?deep=1`
  // probe wall time = sum of all checks (~3-5s when PM2 is slow). Each
  // check is I/O-bound and independent — DB query, PM2 version probe, gh
  // auth check, per-provider binary probes, per-provider quota fetches.
  // Synchronous checks (workspace, project-path) just resolve immediately.
  const includeQuota = options.includeQuota ?? true;
  const [
    dbResult,
    pm2Result,
    schedulerResult,
    providerResults,
    ghResult,
    quotaResults,
  ] = await Promise.all([
    dbCheck(),
    pm2Check(),
    schedulerCheck(),
    Promise.all(providers.map((provider) => providerBinaryCheck(provider, settings))),
    ghCheck(),
    includeQuota ? quotaChecks(settings) : Promise.resolve([]),
  ]);

  const checks: ReadinessCheck[] = [
    dbResult,
    pm2Result,
    workspaceCheck(settings),
    schedulerResult,
  ];
  if (options.projectName) checks.push(projectPathCheck(options.projectName));
  checks.push(...providerResults);
  if (ghResult) checks.push(ghResult);
  checks.push(...quotaResults);

  return {
    ok: checks.every((item) => item.ok || item.severity !== 'error'),
    checks,
  };
}

export async function getReleaseReadinessFailure(
  projectName: string,
  provider: CliProvider,
): Promise<ReadinessCheck | null> {
  const report = await getReadinessReport({ projectName, provider, includeQuota: false });
  return report.checks.find((item) => !item.ok && item.severity === 'error') ?? null;
}
